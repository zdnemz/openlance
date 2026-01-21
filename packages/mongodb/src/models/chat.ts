import mongoose, { type Document, Schema } from 'mongoose'

// ============================================================================
// CONVERSATIONS
// ============================================================================

export interface IConversation extends Document {
  type: 'direct' | 'project' | 'support'
  participants: Array<{
    userId: string
    joinedAt: Date
    leftAt?: Date
  }>
  projectId?: string
  contractId?: string
  lastMessageAt?: Date
  lastMessagePreview?: string
  unreadCount?: Map<string, number>
  isArchived?: Map<string, boolean>
  createdAt: Date
  updatedAt: Date
}

const ConversationSchema = new Schema<IConversation>(
  {
    type: {
      type: String,
      enum: ['direct', 'project', 'support'],
      required: true,
      default: 'direct',
    },
    participants: [
      {
        userId: { type: String, required: true },
        joinedAt: { type: Date, default: Date.now },
        leftAt: { type: Date },
        _id: false,
      },
    ],
    projectId: { type: String, index: true },
    contractId: { type: String, index: true },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String, maxlength: 100 },
    unreadCount: { type: Map, of: Number, default: {} },
    isArchived: { type: Map, of: Boolean, default: {} },
  },
  {
    timestamps: true,
  }
)

ConversationSchema.index({ 'participants.userId': 1, lastMessageAt: -1 })

export const Conversation =
  mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema)

// ============================================================================
// MESSAGES
// ============================================================================

export interface IMessage extends Document {
  conversationId: mongoose.Types.ObjectId
  senderId: string
  type: 'text' | 'file' | 'image' | 'system'
  content: string
  attachments?: Array<{
    fileName: string
    fileUrl: string
    fileSize: number
    mimeType: string
  }>
  replyTo?: mongoose.Types.ObjectId
  readBy?: Array<{
    userId: string
    readAt: Date
  }>
  editedAt?: Date
  deletedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    senderId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ['text', 'file', 'image', 'system'],
      required: true,
      default: 'text',
    },
    content: { type: String, required: true },
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        fileSize: Number,
        mimeType: String,
        _id: false,
      },
    ],
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },
    readBy: [
      {
        userId: { type: String, required: true },
        readAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
  }
)

MessageSchema.index({ conversationId: 1, createdAt: -1 })
MessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 }) // 1 year TTL

export const Message = mongoose.models.Message || mongoose.model<IMessage>('Message', MessageSchema)
