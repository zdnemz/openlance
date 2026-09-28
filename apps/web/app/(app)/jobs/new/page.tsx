"use client";

/** /jobs/new — draft a job with a milestone builder; deposit publishes it. */
import { JobForm } from "@/components/job-form";
import { PageHeader } from "@/components/page-header";
import { RoleGate } from "@/components/role-gate";

export default function NewJobPage() {
  return (
    <RoleGate>
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="Break the work into escrowable chunks."
          desc="This saves a private draft. Depositing the budget publishes it — only funded jobs reach the marketplace."
        />
        <div className="mt-10">
          <JobForm />
        </div>
      </div>
    </RoleGate>
  );
}
