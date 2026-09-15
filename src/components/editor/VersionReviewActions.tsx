"use client";

import { Check, LoaderCircle, RotateCcw, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Review actions for a candidate version: it differs from the version the asset
 * currently points at. Keeping it selects it as current (compare-and-swap on the
 * observed current), discarding leaves the current version untouched.
 */
export default function VersionReviewActions({
  assetId,
  assetHref,
  versionId,
  currentVersionId,
}: {
  assetId: string;
  /** Base asset path; the discard navigation appends the current version. */
  assetHref: string;
  versionId: string;
  currentVersionId: string | null;
}) {
  const router = useRouter();
  const [keeping, setKeeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const keep = async () => {
    if (keeping) return;
    setKeeping(true);
    setError(null);
    setConflict(false);
    try {
      const response = await fetch(`/api/assets/${assetId}/current`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId, expectedCurrentVersionId: currentVersionId ?? null }),
      });
      if (response.ok) {
        router.replace(`${assetHref}?version=${versionId}&review=1`);
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 409 || body.error?.code === "VERSION_CONFLICT") {
        setConflict(true);
        setError("Another version was selected first");
      } else {
        setError(body.error?.message ?? "Unable to keep this edit");
      }
    } catch {
      setError("Unable to keep this edit");
    } finally {
      setKeeping(false);
    }
  };

  const discardHref = currentVersionId ? `${assetHref}?version=${currentVersionId}&review=1` : assetHref;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={() => void keep()} disabled={keeping} className="studio-button-primary sm:flex-1">
          {keeping ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
          {keeping ? "Keeping edit…" : "Keep edit"}
        </button>
        <Link href={discardHref} className="studio-button-secondary sm:flex-1">
          <Undo2 className="size-4" />
          Discard
        </Link>
      </div>
      <p aria-live="polite" className="text-xs text-[var(--muted)]">
        {keeping ? "Making this edit the current version…" : "Discard leaves the current version unchanged. The unselected version remains in history."}
      </p>
      {error && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm text-[var(--danger)] sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          {conflict && (
            <button
              type="button"
              onClick={() => {
                setConflict(false);
                setError(null);
                router.refresh();
              }}
              className="studio-button-secondary min-h-9 py-1.5 text-xs"
            >
              <RotateCcw className="size-3.5" />
              Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}
