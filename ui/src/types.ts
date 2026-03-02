export type SetupState = {
  mode?: string;
  watcher_configured?: boolean;
  last_successful_ingest?: string | null;
  reset_required_before_go_live?: boolean;
  [key: string]: unknown;
};

export type CaseRuntimeMeta = {
  urgency?: "ok" | "attention" | "urgent";
  last_activity_ts?: string | null;
  event_count?: number;
  report_count?: number;
  document_count?: number;
  similarity?: Array<{ case_id: string; score: number }>;
};

export type CaseItem = {
  case_id: string;
  title?: string;
  aliases?: string[];
  tags?: string[];
  runtime?: CaseRuntimeMeta;
  [key: string]: unknown;
};

export type EventItem = {
  id?: string;
  ts?: string;
  type?: string;
  domain?: string;
  entity_id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ReportItem = {
  filename: string;
  path?: string;
  mtime?: string;
  ts?: string | null;
  status?: string | null;
  urgency?: "ok" | "attention" | "urgent";
  warning_count?: number;
  error_count?: number;
  content: Record<string, unknown>;
};

export type IntentItem = {
  filename: string;
  path?: string;
  mtime?: string;
  schema?: string | null;
  id?: string | null;
  ts?: string | null;
  type?: string | null;
  status?: string | null;
  content: Record<string, unknown>;
};

export type InboxItem = {
  name: string;
  path: string;
  size: number;
  mtime: string;
  kind: string;
};

export type DocumentItem = {
  name: string;
  path: string;
  size: number;
  mtime: string;
  ext: string;
  kind: string;
  case_id: string | null;
};

export type TreeNode = {
  name: string;
  children: Record<string, TreeNode>;
  files: Array<{ name: string; path: string; kind: string }>;
};

export type DashboardState = {
  generated_at: string | null;
  setup_state: SetupState;
  last_activity_ts?: string | null;
  urgency?: "ok" | "attention" | "urgent";
  cases: CaseItem[];
  events: EventItem[];
  reports: ReportItem[];
  intents: IntentItem[];
  inbox: {
    count: number;
    items: InboxItem[];
  };
  documents: {
    total: number;
    capped: number;
    tree: TreeNode;
    files: DocumentItem[];
  };
  event_parse_errors?: Array<{ filename: string; line: number; error: string }>;
};
