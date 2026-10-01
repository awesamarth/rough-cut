"use client";

import { useEffect, useRef, useState } from "react";
import { inspectMediaSource } from "@/lib/codec-support";
import { getLocalProject, linkLocalFile, localFile, type MediaDescription } from "@/lib/local-store";

export function useMediaAssets(projectId: string, local: boolean | undefined, musicIds: string[]) {
  const [revision, setRevision] = useState(0);
  const relinking = useRef(new Map<string, AbortController>());
  const ownedUrls = useRef(new Map<string, { file: File; url: string }>());
  useEffect(() => {
    const owned = ownedUrls.current;
    return () => { owned.forEach(({ url }) => URL.revokeObjectURL(url)); owned.clear(); };
  }, []);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, MediaDescription>>({});
  const key = [...new Set(musicIds)].sort().join(",");
  useEffect(() => {
    const pending = relinking.current;
    return () => { pending.forEach((controller) => controller.abort()); pending.clear(); };
  }, [projectId, key]);
  useEffect(() => {
    if (local === undefined) return;
    if (!local) {
      setUrls({ source: `/api/projects/${projectId}/media`, ...Object.fromEntries(key.split(",").filter(Boolean).map((id) => [id, `/api/projects/${projectId}/music?asset=${id}`])) });
      return;
    }
    const created: Record<string, string> = {};
    for (const id of ["source", ...key.split(",").filter(Boolean)]) {
      const file = localFile(projectId, id);
      if (file) {
        let entry = ownedUrls.current.get(id);
        if (entry?.file !== file) {
          if (entry) URL.revokeObjectURL(entry.url);
          entry = { file, url: URL.createObjectURL(file) };
          ownedUrls.current.set(id, entry);
        }
        created[id] = entry.url;
      }
    }
    setUrls(created);
    let disposed = false;
    void getLocalProject(projectId).then((document) => {
      if (document && !disposed) setDescriptions({ source: document.source, ...document.musicAssets });
    });
    return () => { disposed = true; };
  }, [projectId, local, key, revision]);
  const source = local ? localFile(projectId) : urls.source ? new URL(urls.source, location.origin).href : undefined;
  const music = Object.fromEntries(key.split(",").filter(Boolean).flatMap((id) => {
    const value = local ? localFile(projectId, id) : urls[id] ? new URL(urls[id], location.origin).href : undefined;
    return value ? [[id, value]] : [];
  })) as Record<string, File | string>;
  const missing = local ? ["source", ...key.split(",").filter(Boolean)].filter((id) => !urls[id] && descriptions[id]).map((id) => ({ id, description: descriptions[id] })) : [];
  const relink = async (id: string, file: File) => {
    const expected = descriptions[id];
    if (!expected) throw new Error("Media information is not ready. Please try again.");
    relinking.current.get(id)?.abort();
    const controller = new AbortController();
    relinking.current.set(id, controller);
    try {
      await inspectMediaSource(file, id === "source" ? "source" : "audio", controller.signal);
      controller.signal.throwIfAborted();
      linkLocalFile(projectId, id, file, expected);
      setRevision((current) => current + 1);
    } finally {
      if (relinking.current.get(id) === controller) relinking.current.delete(id);
    }
  };
  return { urls, source, music, missing, relink };
}
