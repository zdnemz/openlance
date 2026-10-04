/**
 * Pixel icon set — the one place that knows which pixelarticons glyph stands
 * for which concept. Call sites import by concept (`Gavel` for disputes,
 * `Scales` for the registry) and never reach into the icon package, so a
 * glyph can be swapped here without touching a page.
 *
 * pixelarticons are drawn on a 24x24 grid with no anti-aliasing. They stay
 * crisp at multiples of 12px (12 / 24 / 48); in-between sizes still render
 * with crisp edges but may show uneven stroke widths on 1x displays.
 */
import type { ComponentType, ReactElement, SVGProps } from "react";
import { Analytics as PxAnalytics } from "pixelarticons/react/Analytics";
import { ArrowLeft as PxArrowLeft } from "pixelarticons/react/ArrowLeft";
import { ArrowRight as PxArrowRight } from "pixelarticons/react/ArrowRight";
import { Attachment as PxAttachment } from "pixelarticons/react/Attachment";
import { AvatarSquare as PxAvatarSquare } from "pixelarticons/react/AvatarSquare";
import { Bell as PxBell } from "pixelarticons/react/Bell";
import { BellOff as PxBellOff } from "pixelarticons/react/BellOff";
import { Blocks as PxBlocks } from "pixelarticons/react/Blocks";
import { Briefcase as PxBriefcase } from "pixelarticons/react/Briefcase";
import { Camera as PxCamera } from "pixelarticons/react/Camera";
import { ChartColumnDecreasing as PxChartColumnDecreasing } from "pixelarticons/react/ChartColumnDecreasing";
import { ChartLine as PxChartLine } from "pixelarticons/react/ChartLine";
import { Check as PxCheck } from "pixelarticons/react/Check";
import { CheckDouble as PxCheckDouble } from "pixelarticons/react/CheckDouble";
import { Checkbox as PxCheckbox } from "pixelarticons/react/Checkbox";
import { CheckboxOn as PxCheckboxOn } from "pixelarticons/react/CheckboxOn";
import { ChevronDown as PxChevronDown } from "pixelarticons/react/ChevronDown";
import { ChevronRight as PxChevronRight } from "pixelarticons/react/ChevronRight";
import { Circle as PxCircle } from "pixelarticons/react/Circle";
import { CircleInfo as PxCircleInfo } from "pixelarticons/react/CircleInfo";
import { Clock as PxClock } from "pixelarticons/react/Clock";
import { Close as PxClose } from "pixelarticons/react/Close";
import { CloudServer as PxCloudServer } from "pixelarticons/react/CloudServer";
import { Coins as PxCoins } from "pixelarticons/react/Coins";
import { Comment as PxComment } from "pixelarticons/react/Comment";
import { Compass as PxCompass } from "pixelarticons/react/Compass";
import { Contact as PxContact } from "pixelarticons/react/Contact";
import { Copy as PxCopy } from "pixelarticons/react/Copy";
import { CornerRightUp as PxCornerRightUp } from "pixelarticons/react/CornerRightUp";
import { Crown as PxCrown } from "pixelarticons/react/Crown";
import { Database as PxDatabase } from "pixelarticons/react/Database";
import { ExternalLink as PxExternalLink } from "pixelarticons/react/ExternalLink";
import { FileText as PxFileText } from "pixelarticons/react/FileText";
import { Files as PxFiles } from "pixelarticons/react/Files";
import { Filter as PxFilter } from "pixelarticons/react/Filter";
import { FolderPlus as PxFolderPlus } from "pixelarticons/react/FolderPlus";
import { Gear as PxGear } from "pixelarticons/react/Gear";
import { Globe as PxGlobe } from "pixelarticons/react/Globe";
import { Grid2x22 as PxGrid2x22 } from "pixelarticons/react/Grid2x22";
import { Key as PxKey } from "pixelarticons/react/Key";
import { Layout as PxLayout } from "pixelarticons/react/Layout";
import { Link as PxLink } from "pixelarticons/react/Link";
import { Lock as PxLock } from "pixelarticons/react/Lock";
import { Logout as PxLogout } from "pixelarticons/react/Logout";
import { Membercard as PxMembercard } from "pixelarticons/react/Membercard";
import { Message as PxMessage } from "pixelarticons/react/Message";
import { Money as PxMoney } from "pixelarticons/react/Money";
import { Package as PxPackage } from "pixelarticons/react/Package";
import { Pencil as PxPencil } from "pixelarticons/react/Pencil";
import { Plug as PxPlug } from "pixelarticons/react/Plug";
import { Plus as PxPlus } from "pixelarticons/react/Plus";
import { Radio as PxRadio } from "pixelarticons/react/Radio";
import { Refresh as PxRefresh } from "pixelarticons/react/Refresh";
import { Reload as PxReload } from "pixelarticons/react/Reload";
import { Scale as PxScale } from "pixelarticons/react/Scale";
import { Search as PxSearch } from "pixelarticons/react/Search";
import { Send as PxSend } from "pixelarticons/react/Send";
import { Server as PxServer } from "pixelarticons/react/Server";
import { Shield as PxShield } from "pixelarticons/react/Shield";
import { SpeedFast as PxSpeedFast } from "pixelarticons/react/SpeedFast";
import { Spinner as PxSpinner } from "pixelarticons/react/Spinner";
import { SquareAlert as PxSquareAlert } from "pixelarticons/react/SquareAlert";
import { Star as PxStar } from "pixelarticons/react/Star";
import { Sword as PxSword } from "pixelarticons/react/Sword";
import { Terminal as PxTerminal } from "pixelarticons/react/Terminal";
import { Trash as PxTrash } from "pixelarticons/react/Trash";
import { TrendingUp as PxTrendingUp } from "pixelarticons/react/TrendingUp";
import { Undo as PxUndo } from "pixelarticons/react/Undo";
import { Unlock as PxUnlock } from "pixelarticons/react/Unlock";
import { User as PxUser } from "pixelarticons/react/User";
import { Users as PxUsers } from "pixelarticons/react/Users";
import { Wallet as PxWallet } from "pixelarticons/react/Wallet";
import { WarningDiamond as PxWarningDiamond } from "pixelarticons/react/WarningDiamond";
import { Zap as PxZap } from "pixelarticons/react/Zap";

export type IconProps = SVGProps<SVGSVGElement> & {
  /** Accepted for call-site compatibility; pixel glyphs have a single weight. */
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
};

// A plain function type (not ComponentType) so call sites can narrow `weight`
// in their own `ComponentType<{ weight?: "fill" | "regular" }>` annotations.
export type PixelIcon = (props: IconProps) => ReactElement;

function make(Base: ComponentType<SVGProps<SVGSVGElement>>): PixelIcon {
  return function Icon({ weight: _weight, ...props }: IconProps) {
    // Decorative unless the caller labels it: every icon here sits beside text
    // or inside a labelled control.
    const labelled = props["aria-label"] != null || props["aria-labelledby"] != null;
    return <Base shapeRendering="crispEdges" aria-hidden={labelled ? undefined : true} focusable="false" {...props} />;
  };
}

export const Activity: PixelIcon = make(PxChartLine);
export const ArrowClockwise: PixelIcon = make(PxReload);
export const ArrowLeft: PixelIcon = make(PxArrowLeft);
export const ArrowRight: PixelIcon = make(PxArrowRight);
export const ArrowSquareOut: PixelIcon = make(PxExternalLink);
export const ArrowUpRight: PixelIcon = make(PxCornerRightUp);
export const ArrowsClockwise: PixelIcon = make(PxRefresh);
export const ArrowsCounterClockwise: PixelIcon = make(PxUndo);
export const Bell: PixelIcon = make(PxBell);
export const BellSlash: PixelIcon = make(PxBellOff);
export const Blocks: PixelIcon = make(PxBlocks);
export const Boxes: PixelIcon = make(PxPackage);
export const Briefcase: PixelIcon = make(PxBriefcase);
export const CaretDown: PixelIcon = make(PxChevronDown);
export const CaretRight: PixelIcon = make(PxChevronRight);
export const ChatCircleDots: PixelIcon = make(PxComment);
export const Check: PixelIcon = make(PxCheck);
export const CheckCircle: PixelIcon = make(PxCheckboxOn);
export const Checks: PixelIcon = make(PxCheckDouble);
export const Circle: PixelIcon = make(PxCircle);
export const Clock: PixelIcon = make(PxClock);
export const Coins: PixelIcon = make(PxCoins);
export const Compass: PixelIcon = make(PxCompass);
export const Copy: PixelIcon = make(PxCopy);
export const Database: PixelIcon = make(PxDatabase);
export const FilePlus: PixelIcon = make(PxFolderPlus);
export const FileText: PixelIcon = make(PxFileText);
export const Fingerprint: PixelIcon = make(PxKey);
export const Funnel: PixelIcon = make(PxFilter);
export const Gauge: PixelIcon = make(PxSpeedFast);
export const Gavel: PixelIcon = make(PxSword);
export const GearSix: PixelIcon = make(PxGear);
export const Globe: PixelIcon = make(PxGlobe);
export const HandCoins: PixelIcon = make(PxMoney);
export const Handshake: PixelIcon = make(PxUsers);
export const HardDrive: PixelIcon = make(PxServer);
export const IdentificationBadge: PixelIcon = make(PxMembercard);
export const IdentificationCard: PixelIcon = make(PxContact);
export const Info: PixelIcon = make(PxCircleInfo);
export const Layers: PixelIcon = make(PxFiles);
export const Layout: PixelIcon = make(PxLayout);
export const Lightning: PixelIcon = make(PxZap);
export const Link2: PixelIcon = make(PxLink);
export const Lock: PixelIcon = make(PxLock);
export const LockKeyOpen: PixelIcon = make(PxUnlock);
export const LockOpen: PixelIcon = make(PxUnlock);
export const MagnifyingGlass: PixelIcon = make(PxSearch);
export const MessageSquare: PixelIcon = make(PxMessage);
export const PaperPlaneTilt: PixelIcon = make(PxSend);
export const Paperclip: PixelIcon = make(PxAttachment);
export const PencilSimple: PixelIcon = make(PxPencil);
export const Plugs: PixelIcon = make(PxPlug);
export const Plus: PixelIcon = make(PxPlus);
export const Pulse: PixelIcon = make(PxAnalytics);
export const Radio: PixelIcon = make(PxRadio);
export const Scales: PixelIcon = make(PxScale);
export const Scan: PixelIcon = make(PxCamera);
export const SealCheck: PixelIcon = make(PxCheckboxOn);
export const ServerCog: PixelIcon = make(PxCloudServer);
export const ShieldCheck: PixelIcon = make(PxShield);
export const ShieldStar: PixelIcon = make(PxCrown);
export const ShieldWarning: PixelIcon = make(PxWarningDiamond);
export const SignOut: PixelIcon = make(PxLogout);
export const Spinner: PixelIcon = make(PxSpinner);
export const SpinnerGap: PixelIcon = make(PxSpinner);
export const SquaresFour: PixelIcon = make(PxGrid2x22);
export const Star: PixelIcon = make(PxStar);
export const TerminalWindow: PixelIcon = make(PxTerminal);
export const ToggleLeft: PixelIcon = make(PxCheckbox);
export const ToggleRight: PixelIcon = make(PxCheckboxOn);
export const Trash: PixelIcon = make(PxTrash);
export const TrendDown: PixelIcon = make(PxChartColumnDecreasing);
export const TrendUp: PixelIcon = make(PxTrendingUp);
export const User: PixelIcon = make(PxUser);
export const UserCircle: PixelIcon = make(PxAvatarSquare);
export const Users: PixelIcon = make(PxUsers);
export const Wallet: PixelIcon = make(PxWallet);
export const Warning: PixelIcon = make(PxWarningDiamond);
export const WarningCircle: PixelIcon = make(PxSquareAlert);
export const X: PixelIcon = make(PxClose);
export const Zap: PixelIcon = make(PxZap);
