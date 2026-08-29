import { Uploader } from "@/components/uploader";

export default function Home() {
  return (
    <main className="home-shell">
      <nav className="home-nav">
        <div className="brand"><span>ROUGH</span><i>{"//"}</i><span>CUT</span></div>
        <span className="status-pill"><b /> WebMCP ready</span>
      </nav>
      <section className="hero">
        <p className="eyebrow">Agent-native video editing</p>
        <h1>Your taste.<br /><em>The agent&apos;s hands.</em></h1>
        <p className="hero-copy">Upload a real video, edit it yourself, or let any WebMCP agent operate the same precise timeline tools beside you.</p>
        <Uploader />
      </section>
      <footer className="home-footer"><span>Non-destructive</span><span>Human-first</span><span>Open tooling</span></footer>
    </main>
  );
}
