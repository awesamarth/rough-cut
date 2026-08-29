import { Editor } from "@/components/editor";

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Editor projectId={id} />;
}
