import { useEffect, useId, type ReactNode } from "react";
import {
  Toaster,
  Toast,
  ToastTitle,
  ToastBody,
  useToastController,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkCircleRegular, DismissCircleRegular, InfoRegular } from "@fluentui/react-icons";
import {
  subscribeToasts,
  TOAST_TIMEOUT_MS,
  type ToastIntent,
  type ToastInput,
} from "./toasts.js";

/**
 * Phase 17: the Fluent v9 toaster host — mounts once in the AppShell and dispatches
 * everything that arrives on the toast bus, bottom-end, auto-dismissed, theme/RTL aware.
 * Intent icons give the toast a recognizable glance value (Windows 11 notification style).
 */

const useStyles = makeStyles({
  icon: { display: "flex", alignItems: "center", fontSize: "20px" },
  success: { color: tokens.colorPaletteGreenForeground1 },
  error: { color: tokens.colorPaletteRedForeground1 },
  info: { color: tokens.colorBrandForeground1 },
});

const INTENT_ICON: Record<ToastIntent, ReactNode> = {
  success: <CheckmarkCircleRegular />,
  error: <DismissCircleRegular />,
  info: <InfoRegular />,
};

export function ToastHost(): ReactNode {
  const styles = useStyles();
  // React 19 useId() takes no prefix; the id must be a plain string for the Fluent API.
  const toasterId = `toaster-${useId()}`;
  const { dispatchToast } = useToastController(toasterId);

  useEffect(() => {
    const unsubscribe = subscribeToasts((t: ToastInput) => {
      dispatchToast(
        <Toast>
          <ToastTitle
            media={<span aria-hidden="true" className={`${styles.icon} ${styles[t.intent]}`}>{INTENT_ICON[t.intent]}</span>}
          >
            {t.title}
          </ToastTitle>
          {t.body ? (
            <ToastBody>
              <span title={t.body}>{t.body}</span>
            </ToastBody>
          ) : null}
        </Toast>,
        { timeout: TOAST_TIMEOUT_MS[t.intent] },
      );
    });
    return unsubscribe;
    // `styles` is the stable makeStyles output and INTENT_ICON is module-constant,
    // so toasterId is the only meaningful dependency.
  }, [toasterId, dispatchToast, styles]);

  return <Toaster position="bottom-end" toasterId={toasterId} />;
}
