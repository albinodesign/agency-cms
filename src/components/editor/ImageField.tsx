"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ImagePlus, Loader2, UploadCloud } from "lucide-react";
import type { ManifestField } from "@/types/cms";

const BUCKET = "cms-media";
// Grenzen für Uploads: Handyfotos werden vor dem Hochladen verkleinert,
// damit die Website schnell bleibt und der Speicher nicht explodiert.
const MAX_IMAGE_DIMENSION = 1600;
const MAX_IMAGE_BYTES = 500 * 1024;
const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;

/**
 * Verkleinert ein Bild im Browser (lange Seite max. 1600px) und komprimiert es
 * auf max. ~500 KB. Große Handyfotos werden so automatisch handlich.
 */
function compressImage(file: File): Promise<{ blob: Blob; extension: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Bildverarbeitung wird von diesem Browser nicht unterstützt."));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      // PNG mit Transparenz bleibt PNG, alles andere wird kompaktes JPEG
      const keepPng = file.type === "image/png";
      const tryQuality = (quality: number) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Bild konnte nicht verarbeitet werden."));
              return;
            }
            if (!keepPng && blob.size > MAX_IMAGE_BYTES && quality > 0.5) {
              tryQuality(Math.max(0.5, quality - 0.15));
              return;
            }
            resolve({ blob, extension: keepPng ? "png" : "jpg" });
          },
          keepPng ? "image/png" : "image/jpeg",
          quality
        );
      };
      tryQuality(0.82);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Bilddatei konnte nicht gelesen werden."));
    };
    img.src = objectUrl;
  });
}

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
    // W10: SVG ablehnen – skalierbare Vektorgrafiken können Skripte enthalten
    // und liefen als öffentliche Datei im Bucket (kein SVG-Upload, PNG/JPG/WebP nutzen).
    if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
      onError("SVG-Bilder sind aus Sicherheitsgründen nicht erlaubt. Bitte PNG, JPG oder WebP verwenden.");
      return;
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      onError("Dieses Bild ist größer als 15 MB. Bitte wähle ein kleineres Bild.");
      return;
    }

    setUploading(true);
    try {
      // Handyfotos automatisch verkleinern (max. 1600px, ~500 KB)
      let uploadBlob: Blob = file;
      let fileName = file.name;
      try {
        const compressed = await compressImage(file);
        uploadBlob = compressed.blob;
        const base = fileName.replace(/\.[a-z0-9]+$/i, "");
        fileName = `${base}.${compressed.extension}`;
      } catch {
        // Falls Verkleinern scheitert: Original hochladen statt abbrechen
      }

      const supabase = createClient();
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const path = `sites/${siteId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, uploadBlob, { cacheControl: "3600", upsert: false });

      if (uploadError) {
        // W12: Technische Speicher-Meldungen (RLS/Policies) nicht 1:1 zeigen.
        const roh = uploadError.message ?? "";
        const freundlich = /row.?level|policy|policies|permission|berechtigung|jwt|token|bucket/i.test(roh)
          ? "Keine Berechtigung für diesen Ordner oder Speicher nicht eingerichtet. Bitte die Agentur fragen."
          : roh;
        onError(`Upload fehlgeschlagen: ${freundlich}`);
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
              ? "Bild wird verkleinert & hochgeladen …"
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

      {/* Bildformat-Hinweis aus dem Manifest (hilft Kunden beim richtigen Foto) */}
      {field.aspectRatio === "16:9" && (
        <p className="mt-1.5 text-xs text-zinc-500">💡 Empfohlen: Querformat / Breitbild (16:9)</p>
      )}
      {field.aspectRatio === "1:1" && (
        <p className="mt-1.5 text-xs text-zinc-500">💡 Empfohlen: Quadratisches Bild (1:1)</p>
      )}
      {field.aspectRatio === "4:3" && (
        <p className="mt-1.5 text-xs text-zinc-500">💡 Empfohlen: Standard-Fotoformat (4:3)</p>
      )}
    </div>
  );
}
