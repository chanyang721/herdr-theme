import AppKit
import WebKit
import Foundation

// Render one Mermaid diagram to PNG in an offline, ephemeral WebKit view.
// usage: render-mermaid SOURCE OUTPUT MERMAID_JS THEME BACKGROUND
// Prints {"width","height"} in CSS pixels; the PNG is drawn at 2x for sharp text.
let args=CommandLine.arguments
if args.count<6 { fputs("usage: render-mermaid SOURCE OUTPUT MERMAID_JS THEME BACKGROUND\n",stderr); exit(2) }
let source=(try? String(contentsOfFile:args[1],encoding:.utf8)) ?? ""
let output=URL(fileURLWithPath:args[2])
let library=URL(fileURLWithPath:args[3]).standardizedFileURL
let theme=args[4]=="dark" ? "dark" : "default"
let background=args[5].range(of:"^#[0-9a-fA-F]{6}$",options:.regularExpression) != nil ? args[5] : "#ffffff"
let app=NSApplication.shared
app.setActivationPolicy(.prohibited)

func literal(_ text:String)->String {
    let data=try! JSONSerialization.data(withJSONObject:[text])
    let array=String(data:data,encoding:.utf8)!
    return String(array.dropFirst().dropLast())
}

final class Renderer: NSObject, WKNavigationDelegate {
    let view: WKWebView
    var completed=false
    override init() {
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        view=WKWebView(frame:NSRect(x:0,y:0,width:1600,height:1200),configuration:config)
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
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
        // Evaluate the library directly: a file script tag in an HTML string is not readable.
        guard let code=try? String(contentsOf:library,encoding:.utf8) else {fail("Mermaid library not readable");return}
        view.evaluateJavaScript(code+"\n;0"){_,error in
            if let error=error {self.fail("Mermaid library failed: \(error.localizedDescription)");return}
            self.draw()
        }
    }
    func draw(){
        let script="""
        mermaid.initialize({startOnLoad:false,theme:\(literal(theme)),securityLevel:'strict',htmlLabels:false,flowchart:{htmlLabels:false}});
        const {svg}=await mermaid.render('diagram',\(literal(source)));
        document.getElementById('out').innerHTML=svg;
        const box=document.querySelector('#out svg').getBoundingClientRect();
        return [Math.ceil(box.width),Math.ceil(box.height)];
        """
        view.callAsyncJavaScript(script,arguments:[:],in:nil,in:.page){result in
            switch result {
            case .failure(let error):
                let detail=(error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
                self.fail(detail)
            case .success(let value):
                guard let size=value as? [NSNumber],size.count==2 else {self.fail("Mermaid returned no size");return}
                let width=min(4000,max(1,size[0].doubleValue)),height=min(8000,max(1,size[1].doubleValue))
                self.view.setFrameSize(NSSize(width:width+32,height:height+32))
                DispatchQueue.main.asyncAfter(deadline:.now()+0.1){self.capture(width:width,height:height)}
            }
        }
    }
    func capture(width:Double,height:Double){
        let config=WKSnapshotConfiguration()
        config.rect=CGRect(x:16,y:16,width:width,height:height)
        config.snapshotWidth=NSNumber(value:width*2)
        view.takeSnapshot(with:config){image,error in
            if let error=error{self.fail(error.localizedDescription);return}
            guard let image=image,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {self.fail("WebKit did not produce an image");return}
            do {
                try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
                try png.write(to:output,options:.atomic)
                if let data=try? JSONSerialization.data(withJSONObject:["width":width,"height":height]),let text=String(data:data,encoding:.utf8){print(text)}
                self.completed=true;exit(0)
            }catch{self.fail(error.localizedDescription)}
        }
    }
}

let renderer=Renderer()
DispatchQueue.main.asyncAfter(deadline:.now()+20){renderer.fail("Mermaid rendering timed out")}
// Diagrams render from the local library only; every network request is blocked.
let offlineRules = """
[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}}]
"""
let page="""
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:16px;background:\(background)}</style>
</head><body><div id="out"></div></body></html>
"""
WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"HerdrMermaidOfflineV1",encodedContentRuleList:offlineRules){rules,error in
    guard let rules=rules,error==nil else {renderer.fail("Could not enable offline rendering: \(error?.localizedDescription ?? "unknown error")");return}
    renderer.view.configuration.userContentController.add(rules)
    renderer.view.loadHTMLString(page,baseURL:nil)
}
app.run()
