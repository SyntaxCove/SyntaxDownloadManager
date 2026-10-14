import { describe, expect, it, vi } from "vitest";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import {
  TrayController,
  buildTrayMenuModel,
  buildTrayTooltip,
  countsFromStatuses,
  shouldHideOnClose,
  type TrayMenuItem,
  type TrayPort,
} from "../domains/tray.js";

/**
 * Phase 17 — tray: the pure decision surface (close-to-tray guard, menu model, counts)
 * plus the controller over an injectable TrayPort (throttled pushes, action dispatch).
 */

describe("shouldHideOnClose (Phase 17 close-to-tray guard)", () => {
  it("hides only when the setting is on, the tray exists and we are not quitting", () => {
    expect(shouldHideOnClose(true, true, false)).toBe(true);
    expect(shouldHideOnClose(false, true, false)).toBe(false); // setting off
    expect(shouldHideOnClose(true, false, false)).toBe(false); // no live tray (never strand the user)
    expect(shouldHideOnClose(true, true, true)).toBe(false); // real quit in progress
  });
});

describe("menu model + counts", () => {
  it("counts probing/downloading as active, queued as queued, nothing else", () => {
    expect(countsFromStatuses([
      { status: "downloading" },
      { status: "probing" },
      { status: "queued" },
      { status: "queued" },
      { status: "completed" },
      { status: "paused" },
      { status: "failed" },
      {},
      undefined,
    ])).toEqual({ active: 2, queued: 2 });
    expect(countsFromStatuses([])).toEqual({ active: 0, queued: 0 });
  });

  it("tooltip carries the counts", () => {
    expect(buildTrayTooltip({ active: 2, queued: 1 })).toBe("UniDM — 2 active · 1 queued");
  });

  it("start/pause enable strictly by count; info lines are disabled; open/quit always on", () => {
    const items = buildTrayMenuModel({ active: 0, queued: 3 });
    const byAction = (id: string): TrayMenuItem | undefined =>
      items.find((i) => i.id === id);
    const info = items.find((i) => i.id === null);
    expect(byAction("startAll")?.enabled).toBe(true);
    expect(byAction("pauseAll")?.enabled).toBe(false);
    expect(byAction("open")?.enabled).toBe(true);
    expect(byAction("quit")?.enabled).toBe(true);
    expect(info?.enabled).toBe(false);
    expect(info?.label).toBe("UniDM — 0 active · 3 queued");

    const idle = buildTrayMenuModel({ active: 0, queued: 0 });
    expect(idle.find((i) => i.id === "startAll")?.enabled).toBe(false);
    expect(idle.find((i) => i.id === "pauseAll")?.enabled).toBe(false);
  });
});

type PortSpy = TrayPort & {
  tooltips: string[];
  menus: TrayMenuItem[][];
  clicks: Array<() => void>;
  destroyed: number;
};

function portSpy(): PortSpy {
  const port: PortSpy = {
    tooltips: [],
    menus: [],
    clicks: [],
    destroyed: 0,
    setTooltip(text) {
      port.tooltips.push(text);
    },
    setContextMenu(items) {
      port.menus.push([...items]);
    },
    onClick(cb) {
      port.clicks.push(cb);
    },
    destroy() {
      port.destroyed += 1;
    },
  };
  return port;
}

const supervisor = (): Pick<CoreSupervisor, "request"> => {
  // The core's request is generic (<T>); the mock records calls and answers the
  // startAll/pauseAll shape. The cast satisfies the generic signature at typecheck time
  // (vitest itself never typechecks — this file is covered by the gate's tsc pass).
  const request = vi.fn(async (_m: string, _p?: unknown): Promise<unknown> => ({ started: 0 }));
  return { request: request as unknown as CoreSupervisor["request"] };
};

describe("TrayController", () => {
  it("pushes an initial menu, ignores equal counts and throttles changes to 1/s", () => {
    vi.useFakeTimers();
    try {
      const port = portSpy();
      const sup = supervisor();
      const tray = new TrayController({
        port,
        supervisor: sup,
        onOpen: () => undefined,
        onQuit: () => undefined,
      });
      expect(tray.ready).toBe(true);
      expect(port.menus.length).toBe(1); // initial push
      expect(port.tooltips).toEqual(["UniDM — 0 active · 0 queued"]);

      // A change landing right after the initial push batches into the 1s window.
      tray.updateCounts({ active: 1, queued: 0 });
      expect(port.menus.length).toBe(1);
      vi.advanceTimersByTime(1_100);
      expect(port.menus.length).toBe(2);
      expect(port.tooltips.at(-1)).toBe("UniDM — 1 active · 0 queued");

      tray.updateCounts({ active: 1, queued: 0 }); // equal → ignored
      expect(port.menus.length).toBe(2);

      vi.advanceTimersByTime(1_100); // leave the 1s throttle window entirely
      tray.updateCounts({ active: 2, queued: 0 }); // → immediate
      expect(port.menus.length).toBe(3);
      expect(port.tooltips.at(-1)).toBe("UniDM — 2 active · 0 queued");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches actions: startAll/pauseAll to the core, open/quit to the callbacks", () => {
    const port = portSpy();
    const sup = supervisor();
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    const tray = new TrayController({ port, supervisor: sup, onOpen, onQuit });

    tray.run("startAll");
    tray.run("pauseAll");
    expect(sup.request).toHaveBeenCalledWith("download.startAll", {});
    expect(sup.request).toHaveBeenCalledWith("download.pauseAll", {});

    tray.run("open");
    tray.run("quit");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);

    port.clicks[0]?.(); // tray click = open
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("a failing port surface never breaks the controller", () => {
    const port = portSpy();
    port.setContextMenu = () => {
      throw new Error("no indicator host");
    };
    const sup = supervisor();
    const tray = new TrayController({
      port,
      supervisor: sup,
      onOpen: () => undefined,
      onQuit: () => undefined,
    });
    expect(() => tray.updateCounts({ active: 1, queued: 0 })).not.toThrow();
  });

  it("destroy tears the port down exactly once", () => {
    const port = portSpy();
    const tray = new TrayController({
      port,
      supervisor: supervisor(),
      onOpen: () => undefined,
      onQuit: () => undefined,
    });
    tray.destroy();
    expect(port.destroyed).toBe(1);
  });
});
