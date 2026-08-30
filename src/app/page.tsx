import { Uploader } from "@/components/uploader";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col overflow-hidden bg-[radial-gradient(circle_at_70%_10%,#2c331a_0,transparent_28%),linear-gradient(145deg,#0d0f12,#08090b_65%)] px-[clamp(24px,5vw,80px)] py-7">
      <nav className="flex items-center justify-between" aria-label="Primary">
        <div className="inline-flex items-center gap-[.22em] text-[21px] font-black tracking-[-.07em] text-white"><span>ROUGH</span><i className="not-italic text-[var(--orange)]">{"//"}</i><span>CUT</span></div>
        <span className="inline-flex items-center gap-1.75 rounded-full border border-[#323740] px-2.5 py-1.5 text-[11px] tracking-[.08em] text-[var(--muted)] uppercase"><b className="size-1.75 rounded-full bg-[var(--lime)] shadow-[0_0_10px_var(--lime)]" /> WebMCP ready</span>
      </nav>
      <section className="my-auto w-[min(900px,100%)] py-[70px]">
        <p className="text-xs font-extrabold tracking-[.2em] text-[var(--lime)] uppercase">Agent-native video editing</p>
        <h1 className="my-4 mb-5 max-w-[800px] text-[clamp(58px,8vw,108px)] leading-[.86] tracking-[-.075em]">Your taste.<br /><em className="font-normal not-italic text-[#aeb2b9]">The agent&apos;s hands.</em></h1>
        <p className="max-w-[610px] text-[clamp(16px,2vw,20px)] leading-[1.55] text-[#a7abb3]">Upload a real video, edit it yourself, or let any WebMCP agent operate the same precise timeline tools beside you.</p>
        <Uploader />
      </section>
      <footer className="flex gap-6 text-[10px] tracking-[.13em] text-[#737984] uppercase max-[900px]:flex-wrap"><span>Non-destructive</span><span>Human-first</span><span>Open tooling</span></footer>
    </main>
  );
}
