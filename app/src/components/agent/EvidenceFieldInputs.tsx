import type { ChangeEvent } from "react";
import { describeFormat, type FieldDefinition } from "@/lib/evidence/fields";

export type AttachedPhoto = { name: string; located: boolean };

type Props = {
  fields: FieldDefinition[];
  /** An error message per field key. */
  errors: Record<string, string>;
  photos: Record<string, AttachedPhoto[]>;
  onAddPhotos?: (key: string, files: File[]) => void;
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
      return <input id={id} name={name} className="input" inputMode="tel" placeholder="0712 345 678" />;
    case "single_select":
      if (field.format.options.length <= 4) {
        return (
          <span className="stack-sm" role="radiogroup" aria-labelledby={`${id}-label`}>
            {field.format.options.map((option) => (
              <label key={option.value} className="row small"><input type="radio" name={name} value={option.value} /> {option.label}</label>
            ))}
          </span>
        );
      }
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

function PhotoField({ field, attached, onAdd, onRemove, locationKnown }: {
  field: Extract<FieldDefinition, { type: "photo" }>;
  attached: AttachedPhoto[];
  onAdd?: (files: File[]) => void;
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
      <input id={`f-${field.key}`} type="file" accept={PHOTO_TYPES} capture="environment" multiple={field.format.maxCount > 1} onChange={add} disabled={full} />
      <span className="hint">
        {attached.length} of {field.format.maxCount} attached. Each photo is stamped with its own time and your location when you add it
        {locationKnown ? "" : " (location unavailable, so it will have none)"}.
      </span>
      {attached.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {attached.map((photo, index) => (
            <li key={index}>
              {photo.name} {photo.located ? "" : "(no location)"}{" "}
              <button type="button" className="linkbutton" onClick={() => onRemove?.(index)}>remove</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
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
          <span className="hint">{describeFormat(field)}{field.help ? `. ${field.help}` : ""}</span>
          {errors[field.key] && <span className="field-error">{errors[field.key]}</span>}
        </div>
      ))}
    </>
  );
}
