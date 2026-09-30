// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi } from "vitest";
import {
  detectPasteFindings,
  sanitizePastedText,
  getFindingDisplayName,
  isEditableElement,
  insertTextIntoElement,
  showPasteGuardDialog,
  initPasteGuard,
} from "../src/content/pasteGuard.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";

describe("Paste Guard - Detection", () => {
  it("detects API keys and secrets in pasted text", () => {
    const text = "Here is my secret: sk-1234567890abcdef1234567890 please keep it safe.";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].category).toBe("secrets");
    expect(matches[0].value).toContain("sk-1234567890");
    expect(getFindingDisplayName("secrets", matches[0].value)).toBe("OpenAI API Key");
  });

  it("detects Anthropic API keys", () => {
    const text = "Key: sk-ant-api03-abcdef1234567890abcdef1234567890";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBe(1);
    expect(matches[0].category).toBe("secrets");
    expect(getFindingDisplayName("secrets", matches[0].value)).toBe("Anthropic API Key");
  });

  it("detects Google API keys", () => {
    const text = "Google key: AIzaSyD1234567890abcdef1234567890abcdef";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBe(1);
    expect(matches[0].category).toBe("secrets");
    expect(getFindingDisplayName("secrets", matches[0].value)).toBe("Google API Key");
  });

  it("detects GitHub tokens and Slack tokens", () => {
    expect(getFindingDisplayName("secrets", "ghp_123456789012345678901234567890123456")).toBe("GitHub Token");
    expect(getFindingDisplayName("secrets", "xoxb-1234567890-123456789012-abcdef123456")).toBe("Slack Token");
  });

  it("detects SSNs in pasted text", () => {
    const text = "Customer SSN is 123-45-6789 for application.";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBe(1);
    expect(matches[0].category).toBe("ssn");
    expect(matches[0].value).toBe("123-45-6789");
    expect(getFindingDisplayName("ssn")).toBe("SSN");
  });

  it("detects emails and phone numbers in prompts", () => {
    const prompt = "Can you summarize email from test.user@example.com or call (212) 555-0199?";
    const matches = detectPasteFindings(prompt);
    expect(matches.length).toBe(2);
    const categories = matches.map((m) => m.category);
    expect(categories).toContain("email");
    expect(categories).toContain("phone");
  });

  it("returns empty array for harmless ordinary prompt text", () => {
    const text = "Write a python script to calculate the fibonacci series up to N terms.";
    const matches = detectPasteFindings(text);
    expect(matches).toEqual([]);
  });

  it("returns empty array for empty or whitespace-only text", () => {
    expect(detectPasteFindings("")).toEqual([]);
    expect(detectPasteFindings("   \n\t  ")).toEqual([]);
  });

  it("respects enabledCategories filter", () => {
    const text = "SSN: 123-45-6789 and email: jane@example.com";
    const emailOnly = detectPasteFindings(text, ["email"]);
    expect(emailOnly.length).toBe(1);
    expect(emailOnly[0].category).toBe("email");
  });

  it("detects custom patterns in pasted text", () => {
    const customPattern: CustomPattern = {
      id: "cust-1",
      name: "Internal Project Code",
      category: "custom",
      pattern: "\\bPRJ-[0-9]{4}\\b",
      flags: "g",
      captureGroup: 0,
      source: "local",
      contributionStatus: "local_only",
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };
    const text = "Please review internal ticket PRJ-9821 immediately.";
    const matches = detectPasteFindings(text, ["custom"], [customPattern]);
    expect(matches.length).toBe(1);
    expect(matches[0].category).toBe("custom");
    expect(matches[0].value).toBe("PRJ-9821");
  });
});

describe("Paste Guard - Sanitization", () => {
  it("replaces a single secret with [REDACTED]", () => {
    const text = "Authorization: Bearer sk-1234567890abcdef1234567890 in header";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBe(1);
    const sanitized = sanitizePastedText(text, matches);
    expect(sanitized).toBe("Authorization: Bearer [REDACTED] in header");
  });

  it("replaces multiple entities with [REDACTED] without offset corruption", () => {
    const text = "User test@example.com has SSN 123-45-6789 and phone 212-555-0199.";
    const matches = detectPasteFindings(text);
    expect(matches.length).toBe(3);
    const sanitized = sanitizePastedText(text, matches);
    expect(sanitized).toBe("User [REDACTED] has SSN [REDACTED] and phone [REDACTED].");
    expect(sanitized).not.toContain("test@example.com");
    expect(sanitized).not.toContain("123-45-6789");
    expect(sanitized).not.toContain("212-555-0199");
  });

  it("supports custom placeholder strings", () => {
    const text = "Secret: sk-1234567890abcdef1234567890";
    const matches = detectPasteFindings(text);
    const sanitized = sanitizePastedText(text, matches, "***MASKED***");
    expect(sanitized).toBe("Secret: ***MASKED***");
  });

  it("returns original text when matches array is empty", () => {
    const text = "Completely safe prompt text.";
    expect(sanitizePastedText(text, [])).toBe(text);
  });
});

describe("Paste Guard - Settings & Toggles", () => {
  it("defaults pasteGuardEnabled to true in DEFAULT_SETTINGS", () => {
    expect(DEFAULT_SETTINGS.pasteGuardEnabled).toBe(true);
  });

  it("normalizes pasteGuardEnabled correctly", () => {
    expect(normalizeSettings({ pasteGuardEnabled: false }).pasteGuardEnabled).toBe(false);
    expect(normalizeSettings({ pasteGuardEnabled: true }).pasteGuardEnabled).toBe(true);
    expect(normalizeSettings({}).pasteGuardEnabled).toBe(true);
    expect(normalizeSettings({ pasteGuardEnabled: "invalid" }).pasteGuardEnabled).toBe(true);
  });
});

// Mock DOM factory for Node test environment
function createMockElement(tagName: string, props: Record<string, any> = {}): any {
  const children: any[] = [];
  const attributes: Record<string, string> = {};
  const listeners: Record<string, Function[]> = {};

  const el: any = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    id: props.id || "",
    className: props.className || "",
    type: props.type || (tagName.toLowerCase() === "input" ? "text" : undefined),
    value: props.value || "",
    isContentEditable: props.isContentEditable || false,
    contentEditable: props.contentEditable || "inherit",
    selectionStart: props.selectionStart || 0,
    selectionEnd: props.selectionEnd || 0,
    children,
    childNodes: children,
    style: {},
    innerHTML: "",
    textContent: "",
    getBoundingClientRect: () => ({ left: 50, top: 100, right: 250, bottom: 130, width: 200, height: 30 }),
    focus: vi.fn(),
    setAttribute: (name: string, val: string) => { attributes[name] = val; },
    getAttribute: (name: string) => attributes[name] || null,
    removeAttribute: (name: string) => { delete attributes[name]; },
    appendChild: (child: any) => {
      children.push(child);
      child.parentNode = el;
      return child;
    },
    append: (...items: any[]) => {
      for (const item of items) {
        children.push(item);
        item.parentNode = el;
      }
    },
    remove: vi.fn(() => {
      if (el.parentNode && el.parentNode.children) {
        const idx = el.parentNode.children.indexOf(el);
        if (idx !== -1) el.parentNode.children.splice(idx, 1);
      }
    }),
    addEventListener: (type: string, fn: Function) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: Function) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (ev: any) => {
      if (listeners[ev.type]) {
        for (const fn of listeners[ev.type]) fn(ev);
      }
      return true;
    },
    querySelector: (selector: string) => {
      const findIn = (node: any): any => {
        if (selector.startsWith(".") && node.className?.includes(selector.slice(1))) return node;
        if (selector.startsWith("#") && node.id === selector.slice(1)) return node;
        for (const ch of node.children || []) {
          const res = findIn(ch);
          if (res) return res;
        }
        return null;
      };
      return findIn(el);
    },
    querySelectorAll: (selector: string) => {
      const results: any[] = [];
      const collect = (node: any) => {
        if (selector.startsWith(".") && node.className?.includes(selector.slice(1))) results.push(node);
        if (selector.startsWith("#") && node.id === selector.slice(1)) results.push(node);
        for (const ch of node.children || []) collect(ch);
      };
      collect(el);
      return results;
    },
    getElementById: (id: string) => {
      const findIn = (node: any): any => {
        if (node.id === id) return node;
        for (const ch of node.children || []) {
          const res = findIn(ch);
          if (res) return res;
        }
        return null;
      };
      return findIn(el);
    },
    closest: (sel: string) => {
      if (sel.includes("contenteditable") && el.isContentEditable) return el;
      return null;
    },
    setRangeText: (text: string, start: number, end: number) => {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
    },
    attachShadow: () => {
      const shadow: any = createMockElement("shadow-root");
      shadow.activeElement = null;
      el.shadowRoot = shadow;
      return shadow;
    },
    ...props,
  };

  // Mock instanceof compatibility
  if (tagName.toLowerCase() === "input") {
    Object.setPrototypeOf(el, (globalThis as any).HTMLInputElement?.prototype || Object.prototype);
  } else if (tagName.toLowerCase() === "textarea") {
    Object.setPrototypeOf(el, (globalThis as any).HTMLTextAreaElement?.prototype || Object.prototype);
  } else {
    Object.setPrototypeOf(el, (globalThis as any).HTMLElement?.prototype || Object.prototype);
  }

  return el;
}

function createMockDocument(): any {
  const elementsById: Record<string, any> = {};
  const listeners: Record<string, Function[]> = {};
  const body = createMockElement("body");

  const doc: any = {
    body,
    documentElement: body,
    defaultView: { innerWidth: 1024, innerHeight: 768 },
    createElement: (tag: string) => createMockElement(tag),
    createTextNode: (text: string) => ({ textContent: text, nodeType: 3 }),
    getElementById: (id: string) => {
      if (elementsById[id]) return elementsById[id];
      const findIn = (node: any): any => {
        if (node.id === id) return node;
        for (const ch of node.children || []) {
          const res = findIn(ch);
          if (res) return res;
        }
        return null;
      };
      return findIn(body);
    },
    addEventListener: (type: string, fn: Function) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: Function) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (ev: any) => {
      if (listeners[ev.type]) {
        for (const fn of listeners[ev.type]) fn(ev);
      }
      return true;
    },
  };
  return doc;
}

describe("Paste Guard - DOM Elements & Target Handling", () => {
  it("identifies text input elements as editable", () => {
    const input = createMockElement("input", { type: "text" });
    expect(isEditableElement(input)).toBe(true);

    const textarea = createMockElement("textarea");
    expect(isEditableElement(textarea)).toBe(true);
  });

  it("identifies contenteditable elements", () => {
    const editableDiv = createMockElement("div", { isContentEditable: true });
    expect(isEditableElement(editableDiv)).toBe(true);
  });

  it("rejects non-editable buttons and checkboxes", () => {
    const btn = createMockElement("input", { type: "submit" });
    expect(isEditableElement(btn)).toBe(false);

    const checkbox = createMockElement("input", { type: "checkbox" });
    expect(isEditableElement(checkbox)).toBe(false);
  });

  it("inserts text into HTMLInputElement using range replacement", () => {
    const input = createMockElement("input", { type: "text", value: "Hello ", selectionStart: 6, selectionEnd: 6 });
    const inserted = insertTextIntoElement(input, "World");
    expect(inserted).toBe(true);
    expect(input.value).toBe("Hello World");
  });

  it("inserts text into HTMLTextAreaElement", () => {
    const textarea = createMockElement("textarea", { value: "Initial ", selectionStart: 8, selectionEnd: 8 });
    const inserted = insertTextIntoElement(textarea, "Content");
    expect(inserted).toBe(true);
    expect(textarea.value).toBe("Initial Content");
  });
});

describe("Paste Guard - Floating Dialog & Callbacks", () => {
  it("renders Shadow DOM dialog and triggers onSanitize on button click", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = detectPasteFindings("sk-1234567890abcdef1234567890");
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    const handle = showPasteGuardDialog(doc, target, matches, callbacks);
    expect(handle.host).toBeDefined();

    const shadow = handle.host.shadowRoot as any;
    expect(shadow).toBeDefined();

    const btnSanitize = shadow.getElementById("gw-btn-sanitize") as any;
    expect(btnSanitize).toBeDefined();

    btnSanitize.dispatchEvent({ type: "click" });
    expect(callbacks.onSanitize).toHaveBeenCalledTimes(1);
  });

  it("renders page-derived finding values as text, never as HTML", () => {
    // A hostile page controls the bytes that become match values (e.g. an
    // email domain or a secret's visible head). If those values reached an
    // HTML parser, a crafted paste could inject markup into the dialog.
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = [
      { category: "email", confidence: 0.9, value: "a@<b>evil.com", start: 0, end: 14 },
    ] as Parameters<typeof showPasteGuardDialog>[2];
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    const handle = showPasteGuardDialog(doc, target, matches, callbacks);
    const shadow = handle.host.shadowRoot as any;
    const previews = shadow.querySelectorAll(".gw-finding-preview") as any[];
    expect(previews.length).toBe(1);
    // The masked preview keeps the hostile domain but only as literal text.
    expect(previews[0].textContent).toBe("a***@<b>evil.com");

    const tags: string[] = [];
    const walk = (node: any): void => {
      tags.push(node.tagName);
      for (const child of node.children ?? []) walk(child);
    };
    walk(shadow);
    expect(tags).not.toContain("B");
    expect(tags).not.toContain("IMG");
  });

  it("triggers onRaw on Paste Unchanged click", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = detectPasteFindings("123-45-6789");
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    const handle = showPasteGuardDialog(doc, target, matches, callbacks);
    const shadow = handle.host.shadowRoot as any;
    const btnRaw = shadow.getElementById("gw-btn-raw") as any;

    btnRaw.dispatchEvent({ type: "click" });
    expect(callbacks.onRaw).toHaveBeenCalledTimes(1);
  });

  it("triggers onCancel on Cancel click", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = detectPasteFindings("123-45-6789");
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    const handle = showPasteGuardDialog(doc, target, matches, callbacks);
    const shadow = handle.host.shadowRoot as any;
    const btnCancel = shadow.getElementById("gw-btn-cancel") as any;

    btnCancel.dispatchEvent({ type: "click" });
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it("triggers onCancel on Escape key event", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = detectPasteFindings("123-45-6789");
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    showPasteGuardDialog(doc, target, matches, callbacks);
    doc.dispatchEvent({
      type: "keydown",
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it("triggers onSanitize on Enter key event", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const matches = detectPasteFindings("123-45-6789");
    const callbacks = {
      onSanitize: vi.fn(),
      onRaw: vi.fn(),
      onCancel: vi.fn(),
    };

    showPasteGuardDialog(doc, target, matches, callbacks);
    doc.dispatchEvent({
      type: "keydown",
      key: "Enter",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(callbacks.onSanitize).toHaveBeenCalledTimes(1);
  });
});

describe("Paste Guard - Event Interception & Lifecycle", () => {
  it("intercepts paste on editable input with sensitive text", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const teardown = initPasteGuard(doc);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const pasteEvent = {
      type: "paste",
      target,
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "sk-1234567890abcdef1234567890" : ""),
      },
      preventDefault,
      stopPropagation,
    };

    doc.dispatchEvent(pasteEvent);
    expect(preventDefault).toHaveBeenCalled();

    const host = doc.getElementById("__governworld-paste-guard-host");
    expect(host).not.toBeNull();

    teardown();
  });

  it("allows paste without interception when text is safe", () => {
    const doc = createMockDocument();
    const target = createMockElement("input", { type: "text" });
    doc.body.appendChild(target);

    const teardown = initPasteGuard(doc);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const pasteEvent = {
      type: "paste",
      target,
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "Harmless search query" : ""),
      },
      preventDefault,
      stopPropagation,
    };

    doc.dispatchEvent(pasteEvent);
    expect(preventDefault).not.toHaveBeenCalled();

    const host = doc.getElementById("__governworld-paste-guard-host");
    expect(host).toBeNull();

    teardown();
  });
});
