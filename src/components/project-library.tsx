"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { forgetProject, localProjects } from "@/lib/local-projects";

type ProjectCard = { id: string; name: string; updatedAt: string; status: string; lastOpenedAt: number };

export function ProjectLibrary() {
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const local = localProjects();
    void Promise.all(local.map(async (entry) => {
      try {
        const response = await fetch(`/api/projects/${entry.id}`, { cache: "no-store" });
        if (!response.ok) { if (response.status === 404) forgetProject(entry.id); return null; }
        const project = await response.json() as { id: string; name: string; status: string; updatedAt: string; state?: { name?: string } | null };
        return { id: project.id, name: project.state?.name || project.name, status: project.status, updatedAt: project.updatedAt, lastOpenedAt: entry.lastOpenedAt };
      } catch { return null; }
    })).then((items) => { setProjects(items.filter((item): item is ProjectCard => item !== null).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)); setLoaded(true); });
  }, []);

  if (!loaded || !projects.length) return null;
  return <section className="mt-12 border-t border-[#2d323a] pt-7" aria-labelledby="projects-title"><div className="mb-4 flex items-end justify-between"><div><p className="m-0 text-[10px] font-bold tracking-[.16em] text-[var(--lime)] uppercase">This device</p><h2 id="projects-title" className="mt-1 mb-0 text-2xl">Your projects</h2></div><span className="text-[10px] text-[var(--muted)]">{projects.length} saved</span></div><div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">{projects.map((project) => <article key={project.id} className="group rounded-xl border border-[#303640] bg-[#14171bcc] p-4"><Link href={`/editor/${project.id}`} className="block min-w-0 text-white no-underline"><strong className="block overflow-hidden text-sm text-ellipsis whitespace-nowrap">{project.name}</strong><span className="mt-2 block text-[10px] text-[var(--muted)]">Edited {new Date(project.updatedAt).toLocaleString()}</span></Link><div className="mt-4 flex items-center justify-between"><span className="text-[9px] tracking-[.1em] text-[#858c97] uppercase">{project.status}</span><button className="cursor-pointer border-0 bg-transparent text-[9px] text-[#858c97] hover:text-[#ff9aa9]" onClick={() => { forgetProject(project.id); setProjects((current) => current.filter((item) => item.id !== project.id)); }}>Remove from list</button></div></article>)}</div></section>;
}
