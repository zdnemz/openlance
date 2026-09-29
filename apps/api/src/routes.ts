/**
 * The API surface, generated from the `routes/` directory tree by
 * `scripts/gen-routes.mjs`. A module at `routes/projects/[id]/route.ts` is
 * mounted at `/api/projects/:id`.
 *
 * Edit this only when a route module is added or removed, then regenerate;
 * `check:routes` fails if this table and the tree ever disagree.
 */
import type { Context } from 'hono'

export type RouteHandler = (c: Context) => Promise<Response>

import * as radminIndexerReset from './routes/admin/indexer/reset/route.ts'
import * as radminMockChain from './routes/admin/mock-chain/route.ts'
import * as radminOverview from './routes/admin/overview/route.ts'
import * as radminReconcile from './routes/admin/reconcile/route.ts'
import * as radminReconciliations from './routes/admin/reconciliations/route.ts'
import * as rarbiters from './routes/arbiters/route.ts'
import * as rarbitersAddress from './routes/arbiters/[address]/route.ts'
import * as rattachmentsIdConfirm from './routes/attachments/[id]/confirm/route.ts'
import * as rattachmentsIdUrl from './routes/attachments/[id]/url/route.ts'
import * as rauthLogout from './routes/auth/logout/route.ts'
import * as rauthMe from './routes/auth/me/route.ts'
import * as rauthNonce from './routes/auth/nonce/route.ts'
import * as rauthSponsorship from './routes/auth/sponsorship/route.ts'
import * as rauthVerify from './routes/auth/verify/route.ts'
import * as rauthVoucherChallenge from './routes/auth/voucher-challenge/route.ts'
import * as rdevChainApprove from './routes/dev/chain/approve/route.ts'
import * as rdevChainCancel from './routes/dev/chain/cancel/route.ts'
import * as rdevChainDeregisterArbiter from './routes/dev/chain/deregister-arbiter/route.ts'
import * as rdevChainDispute from './routes/dev/chain/dispute/route.ts'
import * as rdevChainFund from './routes/dev/chain/fund/route.ts'
import * as rdevChainRegisterArbiter from './routes/dev/chain/register-arbiter/route.ts'
import * as rdevChainResolve from './routes/dev/chain/resolve/route.ts'
import * as rdevChainState from './routes/dev/chain/state/route.ts'
import * as rdevChainSubmit from './routes/dev/chain/submit/route.ts'
import * as rdevChainWithdraw from './routes/dev/chain/withdraw/route.ts'
import * as rdevChainWithdrawFees from './routes/dev/chain/withdraw-fees/route.ts'
import * as rdevStack from './routes/dev/stack/route.ts'
import * as rdisputes from './routes/disputes/route.ts'
import * as rdisputesId from './routes/disputes/[id]/route.ts'
import * as rfilesIdRaw from './routes/files/[id]/raw/route.ts'
import * as rhealth from './routes/health/route.ts'
import * as rinternalInbound from './routes/internal/inbound/route.ts'
import * as rjobs from './routes/jobs/route.ts'
import * as rjobsId from './routes/jobs/[id]/route.ts'
import * as rjobsIdCancel from './routes/jobs/[id]/cancel/route.ts'
import * as rjobsIdProposals from './routes/jobs/[id]/proposals/route.ts'
import * as rjobsIdPublish from './routes/jobs/[id]/publish/route.ts'
import * as rledger from './routes/ledger/route.ts'
import * as rledgerSummary from './routes/ledger/summary/route.ts'
import * as rmilestonesIdReviews from './routes/milestones/[id]/reviews/route.ts'
import * as rnotifications from './routes/notifications/route.ts'
import * as rnotificationsPreferences from './routes/notifications/preferences/route.ts'
import * as rnotificationsRead from './routes/notifications/read/route.ts'
import * as roverview from './routes/overview/route.ts'
import * as rprojects from './routes/projects/route.ts'
import * as rprojectsId from './routes/projects/[id]/route.ts'
import * as rprojectsIdArbitersApprove from './routes/projects/[id]/arbiters/approve/route.ts'
import * as rprojectsIdArbitersPropose from './routes/projects/[id]/arbiters/propose/route.ts'
import * as rprojectsIdArbitersReject from './routes/projects/[id]/arbiters/reject/route.ts'
import * as rprojectsIdAttachments from './routes/projects/[id]/attachments/route.ts'
import * as rprojectsIdMessages from './routes/projects/[id]/messages/route.ts'
import * as rprojectsIdMessagesRead from './routes/projects/[id]/messages/read/route.ts'
import * as rprojectsIdMilestones from './routes/projects/[id]/milestones/route.ts'
import * as rprojectsIdMilestonesMidDisputes from './routes/projects/[id]/milestones/[mid]/disputes/route.ts'
import * as rprojectsIdMilestonesMidRequestChanges from './routes/projects/[id]/milestones/[mid]/request-changes/route.ts'
import * as rprojectsIdMilestonesMidSubmissions from './routes/projects/[id]/milestones/[mid]/submissions/route.ts'
import * as rprojectsIdReviews from './routes/projects/[id]/reviews/route.ts'
import * as rproposalsIdAccept from './routes/proposals/[id]/accept/route.ts'
import * as rproposalsIdAttachments from './routes/proposals/[id]/attachments/route.ts'
import * as rproposalsIdWithdraw from './routes/proposals/[id]/withdraw/route.ts'
import * as rready from './routes/ready/route.ts'
import * as rrelay from './routes/relay/route.ts'
import * as rrelayPrepare from './routes/relay/prepare/route.ts'
import * as rrpc from './routes/rpc/route.ts'
import * as rusersAddress from './routes/users/[address]/route.ts'
import * as rusersAddressReviews from './routes/users/[address]/reviews/route.ts'
import * as rusersMe from './routes/users/me/route.ts'
import * as rusersMeKyc from './routes/users/me/kyc/route.ts'
import * as rusersMeRole from './routes/users/me/role/route.ts'
import * as rwebhooks from './routes/webhooks/route.ts'
import * as rwebhooksId from './routes/webhooks/[id]/route.ts'
import * as rwebhooksIdDeliveries from './routes/webhooks/[id]/deliveries/route.ts'
import * as rwebhooksIdDeliveriesDeliveryIdRedeliver from './routes/webhooks/[id]/deliveries/[deliveryId]/redeliver/route.ts'
import * as rwebhooksIdRotate from './routes/webhooks/[id]/rotate/route.ts'
import * as rwebhooksIdTest from './routes/webhooks/[id]/test/route.ts'

export const ROUTES: Array<[string, string, RouteHandler]> = [
  ['POST', '/api/admin/indexer/reset', radminIndexerReset.POST],
  ['GET', '/api/admin/mock-chain', radminMockChain.GET],
  ['GET', '/api/admin/overview', radminOverview.GET],
  ['POST', '/api/admin/reconcile', radminReconcile.POST],
  ['GET', '/api/admin/reconciliations', radminReconciliations.GET],
  ['GET', '/api/arbiters', rarbiters.GET],
  ['GET', '/api/arbiters/:address', rarbitersAddress.GET],
  ['POST', '/api/attachments/:id/confirm', rattachmentsIdConfirm.POST],
  ['GET', '/api/attachments/:id/url', rattachmentsIdUrl.GET],
  ['POST', '/api/auth/logout', rauthLogout.POST],
  ['GET', '/api/auth/me', rauthMe.GET],
  ['GET', '/api/auth/nonce', rauthNonce.GET],
  ['GET', '/api/auth/sponsorship', rauthSponsorship.GET],
  ['POST', '/api/auth/sponsorship', rauthSponsorship.POST],
  ['POST', '/api/auth/verify', rauthVerify.POST],
  ['GET', '/api/auth/voucher-challenge', rauthVoucherChallenge.GET],
  ['POST', '/api/dev/chain/approve', rdevChainApprove.POST],
  ['POST', '/api/dev/chain/cancel', rdevChainCancel.POST],
  ['POST', '/api/dev/chain/deregister-arbiter', rdevChainDeregisterArbiter.POST],
  ['POST', '/api/dev/chain/dispute', rdevChainDispute.POST],
  ['POST', '/api/dev/chain/fund', rdevChainFund.POST],
  ['POST', '/api/dev/chain/register-arbiter', rdevChainRegisterArbiter.POST],
  ['POST', '/api/dev/chain/resolve', rdevChainResolve.POST],
  ['GET', '/api/dev/chain/state', rdevChainState.GET],
  ['POST', '/api/dev/chain/submit', rdevChainSubmit.POST],
  ['POST', '/api/dev/chain/withdraw', rdevChainWithdraw.POST],
  ['POST', '/api/dev/chain/withdraw-fees', rdevChainWithdrawFees.POST],
  ['GET', '/api/dev/stack', rdevStack.GET],
  ['POST', '/api/dev/stack', rdevStack.POST],
  ['GET', '/api/disputes', rdisputes.GET],
  ['GET', '/api/disputes/:id', rdisputesId.GET],
  ['PUT', '/api/files/:id/raw', rfilesIdRaw.PUT],
  ['GET', '/api/files/:id/raw', rfilesIdRaw.GET],
  ['GET', '/api/health', rhealth.GET],
  ['POST', '/api/internal/inbound', rinternalInbound.POST],
  ['GET', '/api/jobs', rjobs.GET],
  ['POST', '/api/jobs', rjobs.POST],
  ['GET', '/api/jobs/:id', rjobsId.GET],
  ['PATCH', '/api/jobs/:id', rjobsId.PATCH],
  ['DELETE', '/api/jobs/:id', rjobsId.DELETE],
  ['POST', '/api/jobs/:id/cancel', rjobsIdCancel.POST],
  ['GET', '/api/jobs/:id/proposals', rjobsIdProposals.GET],
  ['POST', '/api/jobs/:id/proposals', rjobsIdProposals.POST],
  ['POST', '/api/jobs/:id/publish', rjobsIdPublish.POST],
  ['GET', '/api/ledger', rledger.GET],
  ['GET', '/api/ledger/summary', rledgerSummary.GET],
  ['POST', '/api/milestones/:id/reviews', rmilestonesIdReviews.POST],
  ['GET', '/api/milestones/:id/reviews', rmilestonesIdReviews.GET],
  ['GET', '/api/notifications', rnotifications.GET],
  ['GET', '/api/notifications/preferences', rnotificationsPreferences.GET],
  ['PATCH', '/api/notifications/preferences', rnotificationsPreferences.PATCH],
  ['POST', '/api/notifications/read', rnotificationsRead.POST],
  ['GET', '/api/overview', roverview.GET],
  ['GET', '/api/projects', rprojects.GET],
  ['GET', '/api/projects/:id', rprojectsId.GET],
  ['POST', '/api/projects/:id/arbiters/approve', rprojectsIdArbitersApprove.POST],
  ['POST', '/api/projects/:id/arbiters/propose', rprojectsIdArbitersPropose.POST],
  ['POST', '/api/projects/:id/arbiters/reject', rprojectsIdArbitersReject.POST],
  ['POST', '/api/projects/:id/attachments', rprojectsIdAttachments.POST],
  ['GET', '/api/projects/:id/messages', rprojectsIdMessages.GET],
  ['POST', '/api/projects/:id/messages', rprojectsIdMessages.POST],
  ['POST', '/api/projects/:id/messages/read', rprojectsIdMessagesRead.POST],
  ['GET', '/api/projects/:id/milestones', rprojectsIdMilestones.GET],
  ['POST', '/api/projects/:id/milestones/:mid/disputes', rprojectsIdMilestonesMidDisputes.POST],
  ['DELETE', '/api/projects/:id/milestones/:mid/disputes', rprojectsIdMilestonesMidDisputes.DELETE],
  ['POST', '/api/projects/:id/milestones/:mid/request-changes', rprojectsIdMilestonesMidRequestChanges.POST],
  ['POST', '/api/projects/:id/milestones/:mid/submissions', rprojectsIdMilestonesMidSubmissions.POST],
  ['GET', '/api/projects/:id/milestones/:mid/submissions', rprojectsIdMilestonesMidSubmissions.GET],
  ['GET', '/api/projects/:id/reviews', rprojectsIdReviews.GET],
  ['POST', '/api/proposals/:id/accept', rproposalsIdAccept.POST],
  ['POST', '/api/proposals/:id/attachments', rproposalsIdAttachments.POST],
  ['PATCH', '/api/proposals/:id/withdraw', rproposalsIdWithdraw.PATCH],
  ['GET', '/api/ready', rready.GET],
  ['POST', '/api/relay', rrelay.POST],
  ['POST', '/api/relay/prepare', rrelayPrepare.POST],
  ['POST', '/api/rpc', rrpc.POST],
  ['GET', '/api/rpc', rrpc.GET],
  ['GET', '/api/users/:address', rusersAddress.GET],
  ['GET', '/api/users/:address/reviews', rusersAddressReviews.GET],
  ['PATCH', '/api/users/me', rusersMe.PATCH],
  ['POST', '/api/users/me/kyc', rusersMeKyc.POST],
  ['POST', '/api/users/me/role', rusersMeRole.POST],
  ['GET', '/api/webhooks', rwebhooks.GET],
  ['POST', '/api/webhooks', rwebhooks.POST],
  ['DELETE', '/api/webhooks/:id', rwebhooksId.DELETE],
  ['GET', '/api/webhooks/:id/deliveries', rwebhooksIdDeliveries.GET],
  ['POST', '/api/webhooks/:id/deliveries/:deliveryId/redeliver', rwebhooksIdDeliveriesDeliveryIdRedeliver.POST],
  ['POST', '/api/webhooks/:id/rotate', rwebhooksIdRotate.POST],
  ['POST', '/api/webhooks/:id/test', rwebhooksIdTest.POST],
]
