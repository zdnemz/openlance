"use client";

/** /jobs/new — draft a job (brief + max budget); locking the budget publishes it. */
import { JobForm } from "@/components/job-form";
import { PageHeader } from "@/components/page-header";
import { RoleGate } from "@/components/role-gate";

export default function NewJobPage() {
  return (
    <RoleGate>
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="Describe the work. Set your ceiling."
          desc="This saves a private draft — a brief and the most you would pay. Freelancers shape the milestone breakdown themselves; you review the bids and pay the one you accept. Publishing locks your max budget in escrow."
        />
        <div className="mt-10">
          <JobForm />
        </div>
      </div>
    </RoleGate>
  );
}
