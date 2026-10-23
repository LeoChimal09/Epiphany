// Which voice features the dashboard offers right now. Kept apart from the server-only code so the
// browser bundle can import the type.
export interface VoiceStatus {
  listen: boolean;
  speak: boolean;
}
