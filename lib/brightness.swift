// brightness — read or set the main display's brightness, 0.0 to 1.0.
//
// macOS has no public command for this on Apple Silicon. DisplayServices is the
// framework the brightness keys themselves go through; it is loaded at run time
// so a Mac without it fails with a message instead of a crash.
//
//   brightness get        prints the current level, e.g. 0.6019
//   brightness set 0.4    sets it and prints the level it was given
//
// Exit 2 on any failure, with the reason on stderr. The plugin builds this file
// with swiftc on first use (server.ts, ensureBrightnessHelper).
import CoreGraphics
import Foundation

typealias GetFn = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
typealias SetFn = @convention(c) (UInt32, Float) -> Int32

func fail(_ reason: String) -> Never {
    FileHandle.standardError.write(Data((reason + "\n").utf8))
    exit(2)
}

guard let lib = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY) else {
    fail("DisplayServices is not available on this Mac")
}
let display = CGMainDisplayID()
let args = CommandLine.arguments

switch (args.count, args.count > 1 ? args[1] : "") {
case (2, "get"):
    guard let sym = dlsym(lib, "DisplayServicesGetBrightness") else { fail("no brightness reader") }
    var level: Float = -1
    let rc = unsafeBitCast(sym, to: GetFn.self)(display, &level)
    if rc != 0 || level < 0 || level > 1 { fail("could not read the display (rc \(rc))") }
    print(level)
case (3, "set"):
    guard let level = Float(args[2]), level >= 0, level <= 1 else { fail("the level must be between 0 and 1") }
    guard let sym = dlsym(lib, "DisplayServicesSetBrightness") else { fail("no brightness setter") }
    let rc = unsafeBitCast(sym, to: SetFn.self)(display, level)
    if rc != 0 { fail("could not set the display (rc \(rc))") }
    print(level)
default:
    fail("usage: brightness get | brightness set <0..1>")
}
