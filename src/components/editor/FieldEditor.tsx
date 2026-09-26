"use client";

import { ImageField } from "@/components/editor/ImageField";
import { UndoButton } from "@/components/editor/UndoButton";
import { validateDraftValue } from "@/lib/validate";
import type { ManifestField } from "@/types/cms";

export function FieldEditor({
  field,
  value,
  siteId,
  onChange,
  onError,
  selected,
  changed,
  onUndo,
}: {
  field: ManifestField;
  value: string;
  siteId: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
  /** true wenn das Feld gerade per Klick in der Vorschau ausgewählt wurde */
  selected: boolean;
  /** true wenn der Wert vom Live-Stand abweicht (Undo anbieten) */
  changed: boolean;
  onUndo: () => void;
}) {
  const baseClass =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

  const counter = field.maxLength
    ? `${value.length} / ${field.maxLength} Zeichen`
    : `${value.length} Zeichen`;
  const counterTooLong = field.maxLength != null && value.length > field.maxLength;
  // W7: Gleiche Prüfung wie der Server – Fehler sofort am Feld zeigen,
  // statt erst nach dem Publish (leere Werte sind ok = Feld leeren).
  const fehler = validateDraftValue(field.type, value, field.maxLength);
  const inputClass = (base: string) =>
    fehler ? `${base} border-red-400 focus:border-red-600 focus:ring-red-600/10` : base;

  // Anker-ID für "Klick in Vorschau springt hierher" + kurze Gelb-Markierung
  return (
    <div
      id={`cms-field-${field.id}`}
      className={`scroll-mt-4 rounded-xl transition ${
        selected ? "bg-blue-50 p-3 ring-2 ring-blue-600" : ""
      }`}
    >
      {field.type === "image" ? (
        <>
          {changed && (
            <div className="mb-2 flex justify-end">
              <UndoButton onUndo={onUndo} />
            </div>
          )}
          <ImageField
            field={field}
            value={value}
            siteId={siteId}
            onChange={onChange}
            onError={onError}
          />
          {fehler && (
            <p role="alert" className="mt-1 text-xs font-medium text-red-600">
              {fehler} (Wird so nicht veröffentlicht – bitte korrigieren.)
            </p>
          )}
        </>
      ) : (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label className="block text-sm font-medium text-zinc-700">
              {field.label}
            </label>
            {changed && <UndoButton onUndo={onUndo} />}
          </div>

          {field.type === "text" && (
            <input
              type="text"
              value={value}
              placeholder={field.placeholder}
              maxLength={field.maxLength}
              onChange={(e) => onChange(e.target.value)}
              className={inputClass(baseClass)}
              aria-invalid={fehler !== null}
            />
          )}

          {["number", "email", "phone", "url", "date"].includes(field.type) && (
            <input
              type={field.type === "phone" ? "tel" : field.type}
              value={value}
              placeholder={field.placeholder}
              maxLength={field.maxLength}
              onChange={(e) => onChange(e.target.value)}
              className={inputClass(baseClass)}
              aria-invalid={fehler !== null}
            />
          )}

          {field.type === "textarea" && (
            <textarea
              value={value}
              placeholder={field.placeholder}
              maxLength={field.maxLength}
              onChange={(e) => onChange(e.target.value)}
              rows={4}
              className={inputClass(`${baseClass} resize-y`)}
              aria-invalid={fehler !== null}
            />
          )}

          {field.type === "boolean" && (
            <button
              type="button"
              role="switch"
              aria-checked={value === "true"}
              onClick={() => onChange(value === "true" ? "false" : "true")}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                value === "true" ? "bg-emerald-500" : "bg-zinc-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  value === "true" ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          )}
          {field.type === "boolean" && (
            <p className={`mt-1 text-xs font-medium ${value === "true" ? "text-emerald-700" : "text-zinc-400"}`}>
              {value === "true" ? "AN" : "AUS"}
            </p>
          )}

          <p
            className={`mt-1 text-right text-xs ${
              counterTooLong ? "font-medium text-red-600" : "text-zinc-400"
            }`}
          >
            {counter}
          </p>
          {fehler && (
            <p role="alert" className="mt-1 text-xs font-medium text-red-600">
              {fehler} (Wird so nicht veröffentlicht – bitte korrigieren.)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
