import mongoose, { type Document, Schema } from 'mongoose'

// ============================================================================
// ANALYTICS EVENTS
// ============================================================================

export interface IAnalyticsEvent extends Document {
  eventName: string
  userId?: string
  sessionId?: string
  properties?: Record<string, unknown>
  context?: {
    page?: string
    referrer?: string
    utm?: Record<string, string>
    device?: Record<string, unknown>
  }
  timestamp: Date
}

const AnalyticsEventSchema = new Schema<IAnalyticsEvent>(
  {
    eventName: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    sessionId: { type: String },
    properties: { type: Schema.Types.Mixed },
    context: {
      page: String,
      referrer: String,
      utm: Map,
      device: Map,
    },
    timestamp: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: false, updatedAt: false },
  }
)

AnalyticsEventSchema.index({ eventName: 1, timestamp: -1 })
AnalyticsEventSchema.index({ userId: 1, timestamp: -1 }, { sparse: true })
AnalyticsEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 15552000 }) // 180 days TTL

export const AnalyticsEvent =
  mongoose.models.AnalyticsEvent ||
  mongoose.model<IAnalyticsEvent>('AnalyticsEvent', AnalyticsEventSchema)
