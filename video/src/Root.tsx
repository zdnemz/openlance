import { Composition } from "remotion";
import "./fonts";
import { Promo } from "./Promo";
import { FPS, TOTAL_FRAMES } from "./timeline";

export function RemotionRoot() {
  return (
    <>
      <Composition id="Promo" component={Promo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
      <Composition id="PromoVertical" component={Promo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1080} height={1920} />
    </>
  );
}
