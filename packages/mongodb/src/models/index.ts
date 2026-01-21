import mongoose, { type Document, Schema } from 'mongoose'

// Message model for chat/notification history
export interface IMessage extends Document {
  senderId: string
  recipientId: string
  content: string
  type: 'text' | 'file' | 'system'
  read: boolean
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const MessageSchema = new Schema<IMessage>(
  {
    senderId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'file', 'system'], default: 'text' },
    read: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
)

MessageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 })

export const Message = mongoose.models.Message || mongoose.model<IMessage>('Message', MessageSchema)

// Notification model
export interface INotification extends Document {
  userId: string
  title: string
  body: string
  type: 'info' | 'success' | 'warning' | 'error'
  read: boolean
  link?: string
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    read: { type: Boolean, default: false, index: true },
    link: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
)

NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 })

export const Notification =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema)

// Activity log model
export interface IActivityLog extends Document {
  userId: string
  action: string
  resource: string
  resourceId: string
  details?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  createdAt: Date
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    userId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    resource: { type: String, required: true },
    resourceId: { type: String, required: true },
    details: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
)

ActivityLogSchema.index({ userId: 1, createdAt: -1 })
ActivityLogSchema.index({ resource: 1, resourceId: 1 })

export const ActivityLog =
  mongoose.models.ActivityLog || mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema)
