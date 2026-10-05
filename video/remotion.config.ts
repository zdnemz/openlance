import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setCodec("h264");
Config.setCrf(16);
Config.setPixelFormat("yuv420p");
// Pixel art: never let Chrome smooth a scaled sprite or font.
Config.setChromiumOpenGlRenderer("angle");
// Use a preinstalled Chrome Headless Shell when Remotion can't download its own
// (sandboxed CI, offline machines). Unset means Remotion manages the browser.
if (process.env.REMOTION_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.REMOTION_BROWSER_EXECUTABLE);
}
