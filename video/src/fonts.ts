import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// The app's three self-hosted faces (apps/web/app/fonts, OFL), copied into public/fonts.
// loadFont holds the render until each face is ready.
loadFont({ family: "Press Start 2P", url: staticFile("fonts/PressStart2P-Regular.woff2"), weight: "400" });
loadFont({ family: "Pixelify Sans", url: staticFile("fonts/PixelifySans-Variable.woff2"), weight: "400 700" });
loadFont({ family: "IBM Plex Mono", url: staticFile("fonts/IBMPlexMono-400.woff2"), weight: "400" });
loadFont({ family: "IBM Plex Mono", url: staticFile("fonts/IBMPlexMono-500.woff2"), weight: "500" });
