import type { ChangeEvent } from "react";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { PhoneInput } from "@/components/PhoneInput";
import { describeFormat, type FieldDefinition } from "@/lib/evidence/fields";

/** `previewUrl` is an object URL for the thumbnail, made by the form that holds the file. */
export type AttachedPhoto = { name: string; located: boolean; sizeBytes?: number; previewUrl?: string };

type Props = {
  fields: FieldDefinition[];
  /** An error message per field key. */
  errors: Record<string, string>;
  photos: Record<string, AttachedPhoto[]>;
  onAddPhotos?: (key: string, files: File[]) => void | Promise<void>;
  onRemovePhoto?: (key: string, index: number) => void;
  /** Whether the device has a location fix to stamp new photos with. */
  locationKnown: boolean;
  /** Today in Kenya (YYYY-MM-DD), the latest date a no-future date field offers. */
  today: string;
};

const PHOTO_TYPES = "image/jpeg,image/png,image/webp,image/heic,image/heif";

function inputFor(field: FieldDefinition, today: string) {
  const name = `field:${field.key}`;
  const id = `f-${field.key}`;
  switch (field.type) {
    case "text":
      return field.format.maxLength > 200
        ? <textarea id={id} name={name} className="textarea" maxLength={field.format.maxLength} />
        : <input id={id} name={name} className="input" maxLength={field.format.maxLength} inputMode={field.format.pattern === "digits" ? "numeric" : undefined} />;
    case "number":
      return <input id={id} name={name} className="input" inputMode={field.format.decimals === 0 ? "numeric" : "decimal"} />;
    case "date":
      return <input id={id} name={name} type="date" className="input" max={field.format.allowFuture ? undefined : today} />;
    case "phone":
      // Someone else's number (a customer's), so the browser must not offer the agent's own.
      return <PhoneInput id={id} name={name} autoComplete="off" />;
    case "single_select":
      if (field.format.options.length <= 4) return <ChoiceGroup name={name} options={field.format.options} labelledBy={`${id}-label`} />;
      return (
        <select id={id} name={name} className="select" defaultValue="">
          <option value="">Choose one</option>
          {field.format.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    case "photo":
      return null;
  }
}

function PhotoTile({ photo, index, onRemove }: { photo: AttachedPhoto; index: number; onRemove?: () => void }) {
  return (
    <div className="photo-tile">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {photo.previewUrl ? <img src={photo.previewUrl} alt={`Photo ${index + 1}`} /> : <span className="photo-tile-name">{photo.name}</span>}
      <span className="tile-n">{index + 1}</span>
      {!photo.located && <span className="photo-tile-flag">No location</span>}
      <button type="button" className="photo-remove" onClick={onRemove} aria-label={`Remove photo ${index + 1}`}>
        <span aria-hidden="true">&times;</span>
      </button>
    </div>
  );
}

/**
 * Photos as tiles: each added photo shows its thumbnail and a remove button,
 * and the last tile takes a new one (the camera on a phone). The file input
 * covers the whole add tile, so the tile is the target; it stays in the page,
 * disabled and hidden, once the field is full.
 */
function PhotoField({ field, attached, onAdd, onRemove, locationKnown }: {
  field: Extract<FieldDefinition, { type: "photo" }>;
  attached: AttachedPhoto[];
  onAdd?: (files: File[]) => void | Promise<void>;
  onRemove?: (index: number) => void;
  locationKnown: boolean;
}) {
  const full = attached.length >= field.format.maxCount;
  const add = (event: ChangeEvent<HTMLInputElement>) => {
    onAdd?.(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  return (
    <>
      <div className="photo-tiles">
        {attached.map((photo, index) => <PhotoTile key={index} photo={photo} index={index} onRemove={() => onRemove?.(index)} />)}
        <div className={`photo-add${full ? " visually-hidden" : ""}`}>
          <input id={`f-${field.key}`} type="file" accept={PHOTO_TYPES} capture="environment" multiple={field.format.maxCount > 1} onChange={add} disabled={full} />
          <span aria-hidden="true" className="photo-add-plus">+</span>
          <span aria-hidden="true">{attached.length === 0 ? "Take photo" : "Add another"}</span>
        </div>
      </div>
      <span className="hint" role="status">
        <strong>{attached.length} of {field.format.maxCount} attached.</strong> Each photo records the time and your location when you add it
        {locationKnown ? "" : " (your location is not available, so it will have none)"}.
      </span>
    </>
  );
}

/** The format line under a field, left out where the control already shows it. */
function formatHint(field: FieldDefinition): string {
  if (field.type === "single_select") return "";
  if (field.type === "date") return field.format.allowFuture ? "" : "Not in the future";
  return describeFormat(field);
}

/**
 * Renders evidence fields from their definitions (FR-09, issue #47). Nothing
 * here names a field: the label, input, format hint and whether it is
 * mandatory all come from the definition, whether it is one of the
 * platform's fields or one the client configured for the job.
 */
export function EvidenceFieldInputs({ fields, errors, photos, onAddPhotos, onRemovePhoto, locationKnown, today }: Props) {
  return (
    <>
      {fields.map((field) => (
        <div key={field.key} className="field" data-field-key={field.key}>
          <label htmlFor={`f-${field.key}`} id={`f-${field.key}-label`}>
            {field.label}
            {!field.mandatory && <span className="muted"> (optional)</span>}
          </label>
          {field.type === "photo" ? (
            <PhotoField
              field={field}
              attached={photos[field.key] ?? []}
              onAdd={(files) => onAddPhotos?.(field.key, files)}
              onRemove={(index) => onRemovePhoto?.(field.key, index)}
              locationKnown={locationKnown}
            />
          ) : (
            inputFor(field, today)
          )}
          {(formatHint(field) || field.help) && <span className="hint">{[formatHint(field), field.help].filter(Boolean).join(". ")}</span>}
          {errors[field.key] && <span className="field-error">{errors[field.key]}</span>}
        </div>
      ))}
    </>
  );
}
