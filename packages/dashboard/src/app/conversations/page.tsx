import { redirect } from "next/navigation";

export default function ConversationsPage() {
  redirect("/activity?tab=conversations");
}
