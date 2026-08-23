export type { KnownChat } from "../../../src/bot/lark-info";
export type { MeetingConfig, ProfileMode } from "../../../src/config/profile-schema";
export type {
  CotMessagesMode as CotMessages,
  MessageReplyMode as MessageReply,
} from "../../../src/config/schema";
export type { DeviceLogin, UserAuthStatus } from "../../../src/lark-native/user-im";
export type { MeetingPreflight } from "../../../src/meeting/preflight";
export type { MeetingSessionStatus as MeetingSessionInfo } from "../../../src/meeting/session";
export type { ConfigView, MeetingsView, UserChatView as UserChat } from "../../../src/ui/api";
export type { BotSummary as BotInfo, ProfileSummary as ProfileInfo } from "../../../src/ui/fleet";
export type { OnboardState } from "../../../src/ui/onboard";

export interface Status {
  hosted: boolean;
  version: string;
  activeProfile?: string;
  online: number;
}
