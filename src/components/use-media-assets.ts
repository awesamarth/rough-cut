"use client";

import { useEffect, useRef, useState } from "react";
import { getLocalProject, linkLocalFile, localFile, type MediaDescription } from "@/lib/local-store";

export function useMediaAssets(projectId: string, local: boolean | undefined, musicIds: string[]) {
  const [revision, setRevision] = useState(0);
  const ownedUrls = useRef(new Map<string, { file: File; url: string }>());
  useEffect(() => {
    const owned = ownedUrls.current;
    return () => { owned.forEach(({ url }) => URL.revokeObjectURL(url)); owned.clear(); };
  }, []);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, MediaDescription>>({});
  const key = [...new Set(musicIds)].sort().join(",");
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
  const relink = (id: string, file: File) => {
    linkLocalFile(projectId, id, file, descriptions[id]);
    setRevision((current) => current + 1);
  };
  return { urls, source, music, missing, relink };
}
