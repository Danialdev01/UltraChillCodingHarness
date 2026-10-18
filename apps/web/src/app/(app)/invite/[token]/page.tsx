import { InviteAccept } from "@/components/invite-accept";

/** Where an invite link lands: who is asking you in, as what, and a button to join. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-auto p-4 pt-16">
      <div className="w-full max-w-md">
        <InviteAccept token={token} />
      </div>
    </div>
  );
}
