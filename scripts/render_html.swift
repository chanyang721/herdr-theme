import AppKit
import WebKit
import Foundation

// Render one local HTML report to PNG tiles in an ephemeral WebKit view.
// usage: render-html SOURCE OUTPUT_PREFIX THEME WIDTH
// Writes OUTPUT_PREFIX-0.png, -1.png, ... at 2x and prints {"tiles":[{"width","height"}],"truncated"} in CSS pixels.
let args=CommandLine.arguments
if args.count<5 { fputs("usage: render-html SOURCE OUTPUT_PREFIX THEME WIDTH\n",stderr); exit(2) }
let source=URL(fileURLWithPath:args[1]).standardizedFileURL
let prefix=args[2]
let dark=args[3]=="dark"
let width=min(2000,max(320,Double(args[4]) ?? 960))
let tileHeight=2000.0, maxHeight=40000.0, waitCap=8000.0
let app=NSApplication.shared
app.setActivationPolicy(.prohibited)

final class Renderer: NSObject, WKNavigationDelegate {
    let view: WKWebView
    var completed=false
    var truncated=false
    override init() {
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        view=WKWebView(frame:NSRect(x:0,y:0,width:width,height:1200),configuration:config)
        // prefers-color-scheme follows the view's appearance, so the page picks its own dark theme.
        view.appearance=NSAppearance(named:dark ? .darkAqua : .aqua)
        super.init()
        view.navigationDelegate=self
    }
    func fail(_ message:String) {
        guard !completed else {return};completed=true
        if let data=try? JSONSerialization.data(withJSONObject:["error":message]),let text=String(data:data,encoding:.utf8){print(text)}
        exit(1)
    }
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){fail(error.localizedDescription)}
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){fail(error.localizedDescription)}
    // Only the opened file loads as a page; links never navigate away from it.
    func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping (WKNavigationActionPolicy)->Void){
        decisionHandler(action.targetFrame?.isMainFrame == false || action.request.url?.standardizedFileURL==source ? .allow : .cancel)
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
        // Waits for a settled page: fonts, images and network quiet, no DOM changes for a moment,
        // a floor for chart animations, then two frames
        // (capped, since a view outside a window may never draw a frame). Gives up waiting after waitCap.
        let settle="""
        const start=performance.now(), now=()=>performance.now();
        let changed=now(), count=-1, network=now();
        new MutationObserver(()=>{changed=now()}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
        await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,waitCap))]);
        while(now()-start<waitCap){
          const n=performance.getEntriesByType('resource').length;
          if(n!==count){count=n;network=now();}
          const t=now();
          if(document.readyState==='complete'&&[...document.images].every(i=>i.complete)&&t-network>=quiet&&t-changed>=quiet&&t-start>=floor) break;
          await new Promise(r=>setTimeout(r,100));
        }
        await new Promise(r=>{requestAnimationFrame(()=>requestAnimationFrame(r));setTimeout(r,200)});
        // A page laid out by viewport height would grow without end once the view is stretched
        // to the whole document, so vh lengths are pinned to the first viewport in pixels.
        const vh=innerHeight/100, pin=text=>text.replace(/(-?\\d*\\.?\\d+)[sdl]?vh\\b/g,(m,n)=>`${parseFloat(n)*vh}px`);
        const fix=style=>{for(const name of [...style]){const value=style.getPropertyValue(name);if(/vh\\b/.test(value))style.setProperty(name,pin(value),style.getPropertyPriority(name));}};
        const walk=rules=>{for(const rule of rules){if(rule.style)fix(rule.style);if(rule.cssRules)walk(rule.cssRules);}};
        for(const sheet of document.styleSheets){try{walk(sheet.cssRules)}catch{}}
        for(const el of document.querySelectorAll('[style]'))fix(el.style);
        return (()=>{const e=document.documentElement,b=document.body;if(e.scrollHeight>e.clientHeight||!b)return e.scrollHeight;const s=getComputedStyle(b);return Math.ceil(Math.max(0,...[...b.children].map(c=>c.getBoundingClientRect().bottom))+parseFloat(s.paddingBottom)+parseFloat(s.marginBottom))})();
        """
        view.callAsyncJavaScript(settle,arguments:["waitCap":waitCap,"quiet":500,"floor":1000],in:nil,in:.page){result in
            switch result {
            case .failure(let error): self.fail(error.localizedDescription)
            case .success(let value): self.stretch(to:(value as? NSNumber)?.doubleValue ?? 1,rounds:3)
            }
        }
    }
    // Sizes the view to the document, then measures again: content that follows the view size
    // (charts, late images) can still change the height, so a few rounds settle it.
    func stretch(to measured:Double,rounds:Int){
        // A page shorter than the view reports the view height as scrollHeight (quirks-mode bodies
        // fill it too), so such a page is measured by where its content ends.
        let height=min(maxHeight,max(1,measured.rounded(.up)))
        view.setFrameSize(NSSize(width:width,height:height))
        let measure="await new Promise(r=>{requestAnimationFrame(()=>requestAnimationFrame(r));setTimeout(r,200)}); await new Promise(r=>setTimeout(r,300)); return (()=>{const e=document.documentElement,b=document.body;if(e.scrollHeight>e.clientHeight||!b)return e.scrollHeight;const s=getComputedStyle(b);return Math.ceil(Math.max(0,...[...b.children].map(c=>c.getBoundingClientRect().bottom))+parseFloat(s.paddingBottom)+parseFloat(s.marginBottom))})();"
        view.callAsyncJavaScript(measure,arguments:[:],in:nil,in:.page){result in
            let next=((try? result.get()) as? NSNumber)?.doubleValue ?? height
            if rounds>1 && abs(min(maxHeight,next)-height)>1 { self.stretch(to:next,rounds:rounds-1); return }
            self.truncated=next>maxHeight
            self.capture(height:height,index:0,tiles:[])
        }
    }
    func capture(height:Double,index:Int,tiles:[[String:Double]]){
        let top=Double(index)*tileHeight
        if top>=height {
            if let data=try? JSONSerialization.data(withJSONObject:["tiles":tiles,"truncated":truncated] as [String:Any]),let text=String(data:data,encoding:.utf8){print(text)}
            completed=true;exit(0)
        }
        let slice=min(tileHeight,height-top)
        let config=WKSnapshotConfiguration()
        config.rect=CGRect(x:0,y:top,width:width,height:slice)
        config.snapshotWidth=NSNumber(value:width*2)
        view.takeSnapshot(with:config){image,error in
            if let error=error{self.fail(error.localizedDescription);return}
            guard let image=image,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {self.fail("WebKit did not produce an image");return}
            do {
                let output=URL(fileURLWithPath:"\(prefix)-\(index).png")
                try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
                try png.write(to:output,options:.atomic)
                self.capture(height:height,index:index+1,tiles:tiles+[["width":width,"height":slice]])
            }catch{self.fail(error.localizedDescription)}
        }
    }
}

let renderer=Renderer()
DispatchQueue.main.asyncAfter(deadline:.now()+30){renderer.fail("HTML rendering timed out")}
// Reports may load chart libraries and fonts from public CDNs; every other host is blocked.
let allowed=["cdnjs\\\\.cloudflare\\\\.com","cdn\\\\.jsdelivr\\\\.net","unpkg\\\\.com","fonts\\\\.googleapis\\\\.com","fonts\\\\.gstatic\\\\.com"]
// Content rule filters have no alternation, so each scheme and host is its own rule.
let rules="["+([#"{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}"#,#"{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}}"#]
    + allowed.map{#"{"trigger":{"url-filter":"^https://\#($0)/"},"action":{"type":"ignore-previous-rules"}}"#}).joined(separator:",")+"]"
WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"HerdrHtmlReportV1",encodedContentRuleList:rules){list,error in
    guard let list=list,error==nil else {renderer.fail("Could not restrict network access: \(error?.localizedDescription ?? "unknown error")");return}
    renderer.view.configuration.userContentController.add(list)
    renderer.view.loadFileURL(source,allowingReadAccessTo:source.deletingLastPathComponent())
}
app.run()
