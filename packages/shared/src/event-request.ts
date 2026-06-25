export type EventRequestStatus = "pending" | "approved" | "rejected";

export interface EventRequest {
  id: string;
  requesterName: string;
  contactInfo?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  status: EventRequestStatus;
  approvedEventId?: string;
  rejectionReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
}
