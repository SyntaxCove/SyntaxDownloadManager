import { create } from "zustand";
import type { ProxyProfilePublic } from "@syntaxdm/contracts";
import { rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Proxy store (Phase 9) — profiles are redacted by main (password is always null here);
 * the renderer never handles proxy secrets. Test results are keyed per profile.
 */

export type ProxySchemeChoice = "http" | "https" | "socks5";

export interface ProxyDraft {
  name: string;
  scheme: ProxySchemeChoice;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  bypassList: string[];
}

export interface ProxyTestState {
  running: boolean;
  ok?: boolean;
  latencyMs?: number | null;
  exitIp?: string | null;
  status?: number | null;
  errorCode?: string | null;
  error?: string | null;
}

interface ProxyState {
  profiles: ProxyProfilePublic[];
  loaded: boolean;
  testStates: Record<string, ProxyTestState>;
  load: () => Promise<void>;
  create: (input: ProxyDraft) => Promise<void>;
  update: (id: string, patch: Partial<ProxyDraft>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (id: string) => Promise<void>;
  setTestState: (id: string, state: Partial<ProxyTestState>) => void;
}

export const useProxyStore = create<ProxyState>((set, get) => ({
  profiles: [],
  loaded: false,
  testStates: {},

  load: async () => {
    const { profiles } = await rpc("proxy.list", {});
    set({ profiles, loaded: true });
  },

  create: async (input) => {
    const { profile } = await rpc("proxy.create", { profile: input });
    set((s) => ({ profiles: [...s.profiles, profile] }));
  },

  update: async (id, patch) => {
    const { profile } = await rpc("proxy.update", { id, profile: patch });
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? profile : p)) }));
  },

  remove: async (id) => {
    await rpc("proxy.remove", { id });
    set((s) => {
      const { [id]: _removed, ...testStates } = s.testStates;
      return { profiles: s.profiles.filter((p) => p.id !== id), testStates };
    });
  },

  test: async (id) => {
    get().setTestState(id, { running: true, ok: undefined, error: null });
    try {
      const result = await rpc("proxy.test", { profileId: id });
      get().setTestState(id, {
        running: false,
        ok: result.ok,
        latencyMs: result.latencyMs,
        exitIp: result.exitIp,
        status: result.status,
        errorCode: result.errorCode,
      });
    } catch (err) {
      get().setTestState(id, { running: false, ok: false, error: describeError(err) });
    }
  },

  setTestState: (id, state) =>
    set((s) => ({
      testStates: { ...s.testStates, [id]: { running: false, ...s.testStates[id], ...state } },
    })),
}));
