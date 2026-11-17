import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Data, Row } from "./data";

export const DEFAULT_LINK = "";

export type Modal =
  | null
  | { type: "ctx"; leadId: string; text: string; at?: string }
  | { type: "add"; company: string; domain: string; name: string; title: string; linkedin: string; mode: "next" | "now"; for?: string; tried?: boolean };

export type UI = {
  tab: string;
  f: { range: string; from: string; to: string; tiers: string[]; appr: string; scope: string; q: string; period: string; dFrom: string; dTo: string; taskDay: string | null; sort: string; dir: 1 | -1 };
  f2: { rep: string };
  forms: Record<string, any>;
  openAcct: Set<string>;
  openRes: Set<string>;
  openPrep: Set<string>;
  openCtx: Set<string>;
  busy: Set<string>;
  confirmDel: string | null;
  modal: Modal;
  drag: { key: string; block: string } | null;
  openDone: boolean;
  /** Accounts layout and the account open in the side panel (board view). */
  acctView: "table" | "board";
  panel: string | null;
  /** The side panel fills the screen (Expand, or an account opened from its own link). */
  panelFull: boolean;
  /** A board drag waiting on details: the account and the stage it is moving to. */
  move: { k: string; to: number } | null;
  adminSec: string;
  invite: { email: string; role: string };
  integ: { data: any; loading: boolean; err: string; jobs: any };
  blocks: Record<string, string[]>;
  orderLocal: string[] | null;
};

export const initialUI = (): UI => ({
  tab: "accounts",
  f: { range: "all", from: "", to: "", tiers: [], appr: "all", scope: "all", q: "", period: "7", dFrom: "", dTo: "", taskDay: null, sort: "tier", dir: 1 },
  f2: { rep: "all" },
  forms: {},
  openAcct: new Set(),
  openRes: new Set(),
  openPrep: new Set(),
  openCtx: new Set(),
  busy: new Set(),
  confirmDel: null,
  modal: null,
  drag: null,
  openDone: false,
  acctView: "table",
  panel: null,
  panelFull: false,
  move: null,
  adminSec: "users",
  invite: { email: "", role: "sdr" },
  integ: { data: null, loading: false, err: "", jobs: null },
  blocks: {},
  orderLocal: null,
});

export type Ctx = {
  S: UI;
  D: Data;
  session: Session;
  uid: string;
  me: Row | null;
  rerender: () => void;
  toast: (text: string, undo?: (() => any) | null, action?: { label: string; fn: () => any } | null) => void;
};

export const AppCtx = createContext<{ current: Ctx } | null>(null);
export function useX(): Ctx {
  const r = useContext(AppCtx);
  if (!r) throw new Error("No app context");
  return r.current;
}
