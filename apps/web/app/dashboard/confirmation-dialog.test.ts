import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./confirmation-dialog";

describe("confirmation dialog", () => {
  it("shows a named decision with Cancel and explicit confirmation without executing on render", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ConfirmationDialog, {
        confirmation: {
          title: "Mark 2 tasks done?",
          description: "Homework; Reading. Move to history.",
          confirmLabel: "Confirm done",
          onConfirm: confirm,
          onCancel: cancel,
        },
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-labelledby="dashboard-confirm-title"');
    expect(html).toContain("Homework; Reading");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain(">Confirm done</button>");
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
