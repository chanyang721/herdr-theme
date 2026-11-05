import { exec, appHome, window } from "herdr";

// Arguments remain separate from executable code, including names containing quotes.
export const MAC_MEDIA = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
function run(args) {
  var source = args[0], cache = args[1], pageNumber = Number(args[2]), pdf = args[3] === 'pdf';
  var fm = $.NSFileManager.defaultManager;
  var attrs = fm.attributesOfItemAtPathError($(source), null);
  if (!attrs) throw new Error('This file is no longer available or cannot be read.');
  var signature = source + ':' + ObjC.unwrap(attrs.objectForKey($.NSFileModificationDate).timeIntervalSince1970) + ':' + ObjC.unwrap(attrs.objectForKey($.NSFileSize));
  var hash1 = 2166136261, hash2 = 5381;
  for (var i = 0; i < signature.length; i++) { hash1 = Math.imul(hash1 ^ signature.charCodeAt(i), 16777619); hash2 = Math.imul(hash2, 33) ^ signature.charCodeAt(i); }
  var stamp = (hash1 >>> 0).toString(16) + '-' + (hash2 >>> 0).toString(16);
  var ext = source.split('.').pop().toLowerCase(), width, height, pages = 1, data;
  if (pdf) {
    ObjC.import('PDFKit');
    var document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(source)));
    if (!document || document.isLocked) throw new Error('This PDF is locked or cannot be read.');
    pages = Number(document.pageCount);
    if (!pages) throw new Error('This PDF has no pages.');
    pageNumber = Math.max(1, Math.min(pages, pageNumber));
    var page = document.pageAtIndex(pageNumber - 1), bounds = page.boundsForBox(0);
    width = bounds.size.width; height = bounds.size.height;
    var scale = Math.min(2, 2048 / Math.max(width, height));
    var bitmap = page.thumbnailOfSizeForBox($.NSMakeSize(width * scale, height * scale), 0);
    var rep = $.NSBitmapImageRep.imageRepWithData(bitmap.TIFFRepresentation);
    width = Number(rep.pixelsWide); height = Number(rep.pixelsHigh);
    data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    ext = 'png';
  } else if (ext === 'svg') {
    var text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(source), $.NSUTF8StringEncoding, null));
    var box = text.match(/\bviewBox\s*=\s*['"]\s*([-\d.e+]+)[ ,]+([-\d.e+]+)[ ,]+([\d.e+]+)[ ,]+([\d.e+]+)\s*['"]/i);
    var w = text.match(/\bwidth\s*=\s*['"]([\d.]+)(?:px)?['"]/i), h = text.match(/\bheight\s*=\s*['"]([\d.]+)(?:px)?['"]/i);
    width = w ? Number(w[1]) : box ? Number(box[3]) : 300;
    height = h ? Number(h[1]) : box ? Number(box[4]) : 150;
  } else {
    var picture = $.NSImage.alloc.initWithContentsOfFile($(source));
    if (!picture) throw new Error('This image cannot be decoded.');
    var representations = picture.representations, first = representations.objectAtIndex(0);
    width = Number(first.pixelsWide) || picture.size.width;
    height = Number(first.pixelsHigh) || picture.size.height;
  }
  if (!(width > 0 && height > 0)) throw new Error('This file has invalid image dimensions.');
  if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(cache), true, $(), null)) throw new Error('Cannot create the preview cache.');
  var name = stamp + (pdf ? '-page-' + pageNumber : '') + '.' + ext, destination = cache + '/' + name;
  if (!fm.fileExistsAtPath($(destination))) {
    var temporary = destination + '.' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    var written = pdf ? data.writeToFileAtomically($(temporary), true) : fm.copyItemAtPathToPathError($(source), $(temporary), null);
    if (!written) throw new Error('Cannot write the preview cache.');
    if (!fm.moveItemAtPathToPathError($(temporary), $(destination), null)) {
      fm.removeItemAtPathError($(temporary), null);
      if (!fm.fileExistsAtPath($(destination))) throw new Error('Cannot finish the preview cache.');
    }
  }
  return JSON.stringify({ path: 'mods/project-docs-tabs/.cache/' + name, width: width, height: height, pages: pages, page: pageNumber, signature: signature });
}`;

export async function loadMedia(target, page = 1, type = "image") {
  if (target.on) throw new Error("Image and PDF previews are only available for local files.");
  const platform = window()?.platform;
  if (type === "pdf" && platform !== "macos") throw new Error("PDF previews require macOS and PDFKit. Use Open to view this file.");
  const cache = `${appHome()}/mods/project-docs-tabs/.cache`;
  const result = platform === "macos"
    ? await exec("osascript", ["-l", "JavaScript", "-e", MAC_MEDIA, target.file, cache, String(page), type])
    : await exec(`${appHome()}/scripts/sixfold/herdr-theme${platform === "windows" ? ".exe" : ""}`, ["media_image", target.file, cache]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot preview this file.");
  const media = JSON.parse(result.stdout.trim());
  if (!media.path?.startsWith("mods/project-docs-tabs/.cache/") || !(media.width > 0 && media.height > 0 && media.pages > 0)) throw new Error("The media preview returned invalid data.");
  return media;
}

export async function openFile(target) {
  if (target.on) throw new Error("Open is only available for local files.");
  const platform = window()?.platform;
  const command = platform === "macos" ? "open" : platform === "windows" ? "explorer.exe" : "xdg-open";
  const result = await exec(command, [target.file]);
  if (result.code !== 0) throw new Error("The system application could not open this file.");
}
