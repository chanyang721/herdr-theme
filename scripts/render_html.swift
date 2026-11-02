import AppKit
import WebKit
import Foundation

// Render one explicitly selected local page in an ephemeral WebKit session.
// No existing browser profile, cookies or microphone session is used.
let args=CommandLine.arguments
if args.count<5 { fputs("usage: render-html INPUT OUTPUT WIDTH ROOT\n",stderr); exit(2) }
let input=URL(fileURLWithPath:args[1]).standardizedFileURL
let output=URL(fileURLWithPath:args[2])
let width=max(320,min(1600,Double(args[3]) ?? 640))
let root=URL(fileURLWithPath:args[4]).standardizedFileURL
let app=NSApplication.shared
app.setActivationPolicy(.prohibited)

final class Snapshot: NSObject, WKNavigationDelegate, WKUIDelegate {
    let view: WKWebView
    let file: URL
    let out: URL
    let pageWidth: Double
    var completed=false
    init(file:URL,out:URL,width:Double) {
        self.file=file; self.out=out; self.pageWidth=width
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically=false
        config.mediaTypesRequiringUserActionForPlayback = .all
        self.view=WKWebView(frame:NSRect(x:0,y:0,width:width,height:800),configuration:config)
        super.init()
        view.navigationDelegate=self;view.uiDelegate=self
    }
    func fail(_ message:String) {
        guard !completed else {return};completed=true
        let payload:[String:Any]=["error":message]
        if let data=try? JSONSerialization.data(withJSONObject:payload),let text=String(data:data,encoding:.utf8){print(text)}
        exit(1)
    }
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){fail(error.localizedDescription)}
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){fail(error.localizedDescription)}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        // Prevent the selected document's main frame redirecting to another page.
        if navigationAction.targetFrame?.isMainFrame == true,let url=navigationAction.request.url,
           url.standardizedFileURL != file {decisionHandler(.cancel);return}
        decisionHandler(.allow)
    }
    @available(macOS 12.0, *)
    func webView(_ webView:WKWebView,requestMediaCapturePermissionFor origin:WKSecurityOrigin,initiatedByFrame frame:WKFrameInfo,type:WKMediaCaptureType,decisionHandler:@escaping(WKPermissionDecision)->Void){decisionHandler(.deny)}
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
        DispatchQueue.main.asyncAfter(deadline:.now()+0.15){
            self.view.evaluateJavaScript("Math.max(document.body?.scrollHeight||0,document.documentElement.scrollHeight,200)"){value,error in
                if let error=error {self.fail(error.localizedDescription);return}
                let original=(value as? NSNumber)?.doubleValue ?? 800
                let height=min(12000,max(200,original))
                self.view.setFrameSize(NSSize(width:self.pageWidth,height:height))
                DispatchQueue.main.asyncAfter(deadline:.now()+0.1){self.capture(height:height,truncated:original>12000)}
            }
        }
    }
    func capture(height:Double,truncated:Bool){
        let config=WKSnapshotConfiguration()
        config.rect=CGRect(x:0,y:0,width:pageWidth,height:height)
        config.snapshotWidth=NSNumber(value:pageWidth)
        view.takeSnapshot(with:config){image,error in
            if let error=error{self.fail(error.localizedDescription);return}
            guard let image=image,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {self.fail("WebKit did not produce an image");return}
            do {
                try FileManager.default.createDirectory(at:self.out.deletingLastPathComponent(),withIntermediateDirectories:true)
                try png.write(to:self.out,options:.atomic)
                self.view.evaluateJavaScript("Array.from(document.querySelectorAll('link[href],script[src],img[src]')).map(e=>e.href||e.src).filter(u=>u.startsWith('file:')).map(u=>decodeURIComponent(new URL(u).pathname))"){assets,_ in
                    let data:[String:Any]=["width":self.pageWidth,"height":height,"assets":assets as? [String] ?? [],"truncated":truncated]
                    if let encoded=try? JSONSerialization.data(withJSONObject:data),let text=String(data:encoded,encoding:.utf8){print(text)}
                    self.completed=true;exit(0)
                }
            }catch{self.fail(error.localizedDescription)}
        }
    }
}
let snapshot=Snapshot(file:input,out:output,width:width)
DispatchQueue.main.asyncAfter(deadline:.now()+20){snapshot.fail("HTML rendering timed out")}
// Local CSS/JS may render, but remote resources and fetches are blocked by default.
let offlineRules = """
[{"trigger":{"url-filter":"^http://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ws://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss://"},"action":{"type":"block"}}]
"""
WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"HerdrLocalPreviewOfflineV1",encodedContentRuleList:offlineRules){rules,error in
    guard let rules=rules,error==nil else {snapshot.fail("Could not enable offline HTML rendering: \(error?.localizedDescription ?? "unknown error")");return}
    snapshot.view.configuration.userContentController.add(rules)
    snapshot.view.loadFileURL(input,allowingReadAccessTo:root)
}
app.run()
