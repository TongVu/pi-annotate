import type { createChatNoteStore } from "./chat-notes.ts";

type NoteStore = ReturnType<typeof createChatNoteStore>;
type Attachments = Awaited<ReturnType<NoteStore["readAttachments"]>>;
type DelegationDraft = { user: string; brief: string; attachments: Attachments };

function checkedBrief(brief: string) {
  const text = brief.trim();
  if (!text || text.length > 32_000) throw new Error("Prepare a nonempty team brief of up to 32,000 characters.");
  return text;
}

export function createTeamDelegation() {
  let draft: DelegationDraft | undefined;
  let lastStart: string | undefined;
  let preparing: string | undefined;

  return {
    autoDelegate: false,
    async prepare({ user, message, brief, includeNote, readAttachments, current }: {
      user: string; message: string; brief: string; includeNote: boolean;
      readAttachments: () => Promise<Attachments>; current: () => boolean;
    }) {
      if (/^start team$/i.test(message.trim())) throw new Error("Confirm the existing brief instead of preparing a new one.");
      if (preparing) throw new Error("A team brief is already being prepared.");
      if (lastStart === user || draft?.user === user) throw new Error("This message already prepared or started a team brief.");
      if (includeNote && !/\bmarkdown note\b/i.test(message)) throw new Error("Ask the user to specify the Markdown note before including its attachments.");
      brief = checkedBrief(brief);
      preparing = user;
      try {
        const attachments = includeNote ? await readAttachments() : [];
        if (!current()) throw new Error("Main chat changed while preparing the brief. Nothing was sent.");
        draft = { user, brief, attachments };
        return { brief, attachments: attachments.map(({ name }) => name), started: false };
      } finally {
        preparing = undefined;
      }
    },
    startAutomatically(user: string, brief: string, start: (draft: DelegationDraft) => void) {
      if (!this.autoDelegate) throw new Error("Auto-delegate to Teams is off. Nothing was sent.");
      if (preparing || lastStart === user || draft?.user === user) {
        throw new Error("This request already prepared or started a Teams brief.");
      }
      brief = checkedBrief(brief);
      start({ user, brief, attachments: [] });
      lastStart = user;
      draft = undefined;
      return { brief, attachments: [], started: true };
    },
    confirm(user: string, previousUser: string | undefined, message: string, start: (draft: DelegationDraft) => void) {
      if (!draft || !/^start team$/i.test(message.trim()) || previousUser !== draft.user || user === draft.user) {
        throw new Error("To confirm, reply ‘Start team’ directly after the prepared brief. If your request changed, prepare a new brief first.");
      }
      start(draft);
      lastStart = user;
      draft = undefined;
    },
  };
}
