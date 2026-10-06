export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  toolset_name?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string };
}

export interface TabEntry {
  tab_id: string;
  title: string;
  url: string;
  active?: boolean;
}

export type StateChange =
  | { type: "tab_opened"; tab_id: string }
  | { type: "download_started"; download_id: string; url: string }
  | { type: "download_completed"; download_id: string; url: string }
  | { type: "download_failed"; download_id: string; url: string; error?: string };

export interface BrowserStateBlock {
  type: "browser_state";
  tabs: TabEntry[];
  state_changes?: StateChange[];
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  toolset_name?: string;
  content: Array<TextBlock | ImageBlock | BrowserStateBlock>;
  is_error?: boolean;
}
