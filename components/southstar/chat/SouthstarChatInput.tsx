"use client";

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import type { SouthstarChatCapabilities } from "@/lib/southstar/api-client";

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export type SouthstarChatInputHandle = {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  addImages: (files: File[]) => void;
};

type ModelSelection = {
  provider: string;
  modelId: string;
};

type Props = {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: ModelSelection | null;
  modelList: SouthstarChatCapabilities["modelList"];
  onModelChange?: (provider: string, modelId: string) => void;
  skillCommands: SouthstarChatCapabilities["skillCommands"];
  toolPreset?: string;
  toolPresets: SouthstarChatCapabilities["toolPresets"];
  onToolPresetChange?: (preset: string) => void;
  thinkingLevel?: string;
  thinkingLevels: string[];
  onThinkingLevelChange?: (level: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  attachmentsEnabled?: boolean;
};

export const SouthstarChatInput = forwardRef<SouthstarChatInputHandle, Props>(function SouthstarChatInput(props, ref) {
  const [value, setValue] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  const modelList = props.modelList;
  const skillCommands = props.skillCommands;
  const toolPreset = props.toolPreset;
  const thinkingLevel = props.thinkingLevel;

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      setValue((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}${text}`);
      textareaRef.current?.focus();
    },
    insertIfEmpty(text: string) {
      setValue((current) => current.trim().length > 0 ? current : text);
      textareaRef.current?.focus();
    },
    addImages(files: File[]) {
      if (!props.attachmentsEnabled) return;
      void processImageFiles(files);
    },
  }));

  const slashSuggestions = useMemo(() => {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const query = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
    return skillCommands
      .filter((item) => item.command.toLowerCase().includes(query) || (item.skill ?? "").toLowerCase().includes(query))
      .slice(0, 12);
  }, [skillCommands, value]);

  const modelValue = props.model ? `${props.model.provider}:${props.model.modelId}` : "";

  const processImageFiles = useCallback(async (files: File[]) => {
    if (!props.attachmentsEnabled) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const nextImages = await Promise.all(images.map(readAttachedImage));
    setAttachedImages((current) => [...current, ...nextImages]);
  }, [props.attachmentsEnabled]);

  const clearImages = useCallback(() => {
    setAttachedImages((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return [];
    });
  }, []);

  const send = useCallback(() => {
    const message = value.trim();
    if (props.isStreaming || (message.length === 0 && attachedImages.length === 0)) return;
    props.onSend(message);
    setValue("");
    clearImages();
    resetTextareaHeight(textareaRef.current);
  }, [attachedImages, clearImages, props, value]);

  const sendQueued = useCallback((mode: "steer" | "follow-up") => {
    const message = value.trim();
    if (message.length === 0 && attachedImages.length === 0) return;
    if (mode === "steer") props.onSteer?.(message);
    else props.onFollowUp?.(message);
    setValue("");
    clearImages();
    resetTextareaHeight(textareaRef.current);
  }, [attachedImages, clearImages, props, value]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "ArrowDown" && slashSuggestions.length > 0) {
      event.preventDefault();
      setSlashSuggestionIndex((current) => (current + 1) % slashSuggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && slashSuggestions.length > 0) {
      event.preventDefault();
      setSlashSuggestionIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
      return;
    }
    if ((event.key === "Tab" || event.key === "Enter") && slashSuggestions.length > 0 && value.trimStart().match(/^\/\S*$/)) {
      event.preventDefault();
      const selected = slashSuggestions[slashSuggestionIndex];
      if (selected) setValue(`/${selected.command} `);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !isComposingRef.current) {
      event.preventDefault();
      if (props.isStreaming && props.onSteer) sendQueued("steer");
      else if (props.isStreaming && props.onFollowUp) sendQueued("follow-up");
      else send();
    }
  }, [props.isStreaming, props.onFollowUp, props.onSteer, send, sendQueued, slashSuggestionIndex, slashSuggestions, value]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0 || !props.attachmentsEnabled) return;
    event.preventDefault();
    void processImageFiles(files);
  }, [processImageFiles]);

  return (
    <div className="ss-native-chat-input">
      {props.compactError ? <p className="ss-native-input-error">{props.compactError}</p> : null}
      {attachedImages.length > 0 ? (
        <div className="ss-native-attachments">
          {attachedImages.map((image, index) => (
            <span key={`${image.mimeType}-${index}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.previewUrl} alt="" />
              <button
                type="button"
                onClick={() => {
                  setAttachedImages((current) => current.filter((_image, imageIndex) => {
                    if (imageIndex === index) URL.revokeObjectURL(current[imageIndex]!.previewUrl);
                    return imageIndex !== index;
                  }));
                }}
              >
                x
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ss-native-input-box">
        {slashSuggestions.length > 0 ? (
          <div className="ss-native-slash-suggestions">
            {slashSuggestions.map((suggestion, index) => (
              <button
                type="button"
                key={suggestion.command}
                className={index === slashSuggestionIndex ? "ss-active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setValue(`/${suggestion.command} `);
                  setSlashSuggestionIndex(index);
                }}
              >
                <strong>/{suggestion.command}</strong>
                <small>{suggestion.description ?? suggestion.skill ?? suggestion.command}</small>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={props.isStreaming ? "Steer or queue a follow-up..." : "Message Southstar..."}
          onChange={(event) => {
            setValue(event.target.value);
            growTextarea(event.currentTarget);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
        />
        <div className="ss-native-input-actions">
          {props.isStreaming ? (
            <>
              <button type="button" onClick={() => sendQueued("steer")} disabled={!props.onSteer || (value.trim().length === 0 && attachedImages.length === 0)}>
                Steer
              </button>
              <button type="button" onClick={() => sendQueued("follow-up")} disabled={!props.onFollowUp || (value.trim().length === 0 && attachedImages.length === 0)}>
                Follow-up
              </button>
              <button type="button" onClick={props.onAbort}>Abort</button>
            </>
          ) : (
            <button type="button" onClick={send} disabled={value.trim().length === 0 && attachedImages.length === 0}>
              Send
            </button>
          )}
        </div>
      </div>
      <div className="ss-native-input-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            if (props.attachmentsEnabled) void processImageFiles(Array.from(event.target.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!props.attachmentsEnabled || props.isStreaming}>
          Attach image
        </button>
        <select
          aria-label="Model"
          value={modelValue}
          disabled={props.isStreaming || modelList.length === 0}
          onChange={(event) => {
            const [provider, ...modelIdParts] = event.target.value.split(":");
            const modelId = modelIdParts.join(":");
            if (provider && modelId) props.onModelChange?.(provider, modelId);
          }}
        >
          {modelList.map((model) => (
            <option key={`${model.provider}:${model.modelId}`} value={`${model.provider}:${model.modelId}`}>
              {model.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Tool preset"
          value={toolPreset ?? props.toolPresets[0]?.id ?? "default"}
          onChange={(event) => props.onToolPresetChange?.(event.target.value)}
        >
          {props.toolPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label ?? preset.id}
            </option>
          ))}
        </select>
        <select
          aria-label="Thinking level"
          value={thinkingLevel ?? props.thinkingLevels[0] ?? "auto"}
          onChange={(event) => props.onThinkingLevelChange?.(event.target.value)}
        >
          {props.thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {props.isCompacting ? (
          <button type="button" onClick={props.onAbortCompaction}>Abort compact</button>
        ) : (
          <button type="button" onClick={props.onCompact} disabled={!props.onCompact}>
            Compact
          </button>
        )}
      </div>
    </div>
  );
});

function readAttachedImage(file: File): Promise<AttachedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve({
        data: dataUrl.split(",")[1] ?? "",
        mimeType: file.type,
        previewUrl: URL.createObjectURL(file),
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function growTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function resetTextareaHeight(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
}
