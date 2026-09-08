"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ImagePlus, Loader2, UploadCloud } from "lucide-react";
import type { ManifestField } from "@/types/cms";

const BUCKET = "cms-media";

interface ImageFieldProps {
  field: ManifestField;
  value: string;
  siteId: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}

export function ImageField({
  field,
  value,
  siteId,
  onChange,
  onError,
}: ImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function uploadFile(file: File) {
    if (!file.type.startsWith("image/")) {
      onError("Nur Bilddateien sind erlaubt (PNG, JPG, WebP, …).");
      return;
    }

    setUploading(true);
    try {
      const supabase = createClient();
      const path = `sites/${siteId}/${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: false });

      if (uploadError) {
        onError(`Upload fehlgeschlagen: ${uploadError.message}`);
        return;
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from(BUCKET).getPublicUrl(path);

      // Trägt URL ein, sendet postMessage an den Iframe und speichert den Draft
      onChange(publicUrl);
    } catch {
      onError("Supabase Storage ist nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-zinc-700">
        {field.label}
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void uploadFile(file);
        }}
        className={`rounded-xl border-2 border-dashed p-4 transition ${
          dragging
            ? "border-zinc-900 bg-zinc-100"
            : "border-zinc-300 bg-white hover:border-zinc-400"
        }`}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt={field.label}
            className="mb-3 h-32 w-full rounded-lg border border-zinc-200 object-cover"
          />
        ) : (
          <div className="mb-3 flex h-32 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400">
            <ImagePlus className="h-8 w-8" />
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">
            {uploading
              ? "Bild wird hochgeladen …"
              : "Bild hierher ziehen oder"}
          </p>
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UploadCloud className="h-3.5 w-3.5" />
            )}
            Bild austauschen
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadFile(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* URL weiterhin manuell editierbar */}
      <input
        type="url"
        value={value}
        placeholder={field.placeholder ?? "https://…/bild.jpg"}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-600 outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
      />
    </div>
  );
}
