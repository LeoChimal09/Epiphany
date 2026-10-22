import type { Principal } from "../services";

// What the Discord side reports after trying to set up the owner's private channels. The assistant
// turns this into a reply; it never claims more than the result says happened.
export type WorkspaceSetupResult =
  // The workspace exists. `created` lists the text channels made now (empty when everything was
  // already there) and `categoryCreated` says whether the private category itself was new.
  | { status: "ready"; server: string; created: string[]; categoryCreated: boolean }
  // The owner shares more than one server with Epi and did not say which.
  | { status: "choose"; servers: string[] }
  // Epi is in no server that the owner is a member of.
  | { status: "no_server" }
  // Setup stopped early. `created` lists anything made before it stopped.
  | {
      status: "blocked";
      server: string;
      created: string[];
      categoryCreated: boolean;
      reason: "missing_permissions" | "failed";
    }
  | { status: "unavailable" };

// Supplied by the Discord runtime. The assistant only calls it for a verified private owner
// conversation, after the permission matrix allows "workspace.setup".
export interface WorkspaceCapability {
  setup(principal: Principal, server: string | undefined): Promise<WorkspaceSetupResult>;
}

export type VoiceAction =
  "join" | "leave" | "stop_listening" | "resume_listening" | "mute_replies" | "unmute_replies";

export const VOICE_ACTIONS: readonly VoiceAction[] = [
  "join",
  "leave",
  "stop_listening",
  "resume_listening",
  "mute_replies",
  "unmute_replies",
];

// What the voice runtime reports; the assistant words the reply from it.
export type VoiceControlResult =
  | { status: "ok"; text: string }
  // The owner asked to join but is not in a voice channel Epi can see.
  | { status: "not_in_voice" }
  | { status: "nothing_to_do" }
  | { status: "unavailable" };

// Supplied by the Discord runtime when live voice is set up; absent in the dashboard.
export interface VoiceCapability {
  control(principal: Principal, action: VoiceAction): Promise<VoiceControlResult>;
}
