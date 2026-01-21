import mongoose, { type Document, Schema } from 'mongoose'

// ============================================================================
// NOTIFICATIONS
// ============================================================================

export interface INotification extends Document {
  userId: string
  type: string
  title: string
  body: string
  data?: {
    entityType: string
    entityId: string
    actionUrl?: string
  }
  channels: Array<'in_app' | 'email' | 'push'>
  status: {
    in_app?: { sent: boolean; read: boolean; readAt?: Date }
    email?: { sent: boolean; sentAt?: Date }
    push?: { sent: boolean; sentAt?: Date }
  }
  priority: 'low' | 'normal' | 'high'
  createdAt: Date
  expiresAt?: Date
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: {
      entityType: String,
      entityId: String,
      actionUrl: String,
    },
    channels: [{ type: String, enum: ['in_app', 'email', 'push'] }],
    status: {
      in_app: {
        sent: { type: Boolean, default: false },
        read: { type: Boolean, default: false },
        readAt: Date,
      },
      email: {
        sent: { type: Boolean, default: false },
        sentAt: Date,
      },
      push: {
        sent: { type: Boolean, default: false },
        sentAt: Date,
      },
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
    expiresAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
)

NotificationSchema.index({ userId: 1, createdAt: -1 })
NotificationSchema.index({ userId: 1, 'status.in_app.read': 1 })
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }) // TTL

export const Notification =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema)

// ============================================================================
// ACTIVITY LOGS
// ============================================================================

export interface IActivityLog extends Document {
  userId?: string
  sessionId?: string
  action: string
  resource: {
    type: string
    id: string
  }
  metadata?: Record<string, unknown>
  ip?: string
  userAgent?: string
  geo?: {
    country?: string
    city?: string
  }
  createdAt: Date
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    userId: { type: String, index: true },
    sessionId: { type: String },
    action: { type: String, required: true },
    resource: {
      type: { type: String, required: true },
      id: { type: String, required: true },
    },
    metadata: { type: Schema.Types.Mixed },
    ip: { type: String },
    userAgent: { type: String },
    geo: {
      country: String,
      city: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
)

ActivityLogSchema.index({ userId: 1, createdAt: -1 })
ActivityLogSchema.index({ action: 1, createdAt: -1 })
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }) // 90 days TTL

export const ActivityLog =
  mongoose.models.ActivityLog || mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema)
