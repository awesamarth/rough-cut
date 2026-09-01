const KEY = "rough-cut-projects";

type LocalProject = { id: string; lastOpenedAt: number };

export function localProjects(): LocalProject[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "[]") as LocalProject[];
    return Array.isArray(value) ? value.filter((item) => typeof item.id === "string" && Number.isFinite(item.lastOpenedAt)) : [];
  } catch { return []; }
}

export function rememberProject(id: string) {
  const projects = localProjects().filter((item) => item.id !== id);
  localStorage.setItem(KEY, JSON.stringify([{ id, lastOpenedAt: Date.now() }, ...projects].slice(0, 50)));
}

export function forgetProject(id: string) {
  localStorage.setItem(KEY, JSON.stringify(localProjects().filter((item) => item.id !== id)));
}
