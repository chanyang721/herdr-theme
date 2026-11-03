import AppKit
import WebKit
import Foundation

// Render one local HTML report to PNG tiles in an ephemeral WebKit view.
// usage: render-html SOURCE OUTPUT_PREFIX THEME WIDTH
// Writes OUTPUT_PREFIX-0.png, -1.png, ... at 2x and prints {"tiles":[{"width","height"}]} in CSS pixels.
let args=CommandLine.arguments
if args.count<5 { fputs("usage: render-html SOURCE OUTPUT_PREFIX THEME WIDTH\n",stderr); exit(2) }
let source=URL(fileURLWithPath:args[1]).standardizedFileURL
let prefix=args[2]
let dark=args[3]=="dark"
let width=min(2000,max(320,Double(args[4]) ?? 960))
let tileHeight=2000.0, maxHeight=40000.0
let app=NSApplication.shared
app.setActivationPolicy(.prohibited)

final class Renderer: NSObject, WKNavigationDelegate {
    let view: WKWebView
    var completed=false
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
        // Give fonts and chart animations time to settle before measuring.
        let script="await document.fonts.ready; await new Promise(r=>setTimeout(r,1500)); return document.documentElement.scrollHeight;"
        view.callAsyncJavaScript(script,arguments:[:],in:nil,in:.page){result in
            switch result {
            case .failure(let error): self.fail(error.localizedDescription)
            case .success(let value):
                let height=min(maxHeight,max(1,(value as? NSNumber)?.doubleValue ?? 1))
                self.view.setFrameSize(NSSize(width:width,height:height))
                DispatchQueue.main.asyncAfter(deadline:.now()+0.5){self.capture(height:height,index:0,tiles:[])}
            }
        }
    }
    func capture(height:Double,index:Int,tiles:[[String:Double]]){
        let top=Double(index)*tileHeight
        if top>=height {
            if let data=try? JSONSerialization.data(withJSONObject:["tiles":tiles]),let text=String(data:data,encoding:.utf8){print(text)}
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
