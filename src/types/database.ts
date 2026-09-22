/**
 * Mirrors the Supabase schema. This is the generator's output with its
 * long-form helper generics replaced by the simpler equivalents below, so
 * regenerate with `npm run db:types` after a migration and re-apply that
 * trim, or the row types drift from the database.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      channel_secrets: {
        Row: {
          access_token: string | null;
          channel_id: string;
          created_at: string;
          expires_at: string | null;
          refresh_token: string | null;
          tenant_id: string;
          updated_at: string;
          webhook_secret: string | null;
        };
        Insert: {
          access_token?: string | null;
          channel_id: string;
          created_at?: string;
          expires_at?: string | null;
          refresh_token?: string | null;
          tenant_id: string;
          updated_at?: string;
          webhook_secret?: string | null;
        };
        Update: {
          access_token?: string | null;
          channel_id?: string;
          created_at?: string;
          expires_at?: string | null;
          refresh_token?: string | null;
          tenant_id?: string;
          updated_at?: string;
          webhook_secret?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "channel_secrets_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: true;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_secrets_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          config: Json;
          created_at: string;
          display_name: string;
          external_account_id: string | null;
          id: string;
          last_error: string | null;
          last_synced_at: string | null;
          status: Database["public"]["Enums"]["channel_status"];
          tenant_id: string;
          type: Database["public"]["Enums"]["channel_type"];
          updated_at: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          display_name: string;
          external_account_id?: string | null;
          id?: string;
          last_error?: string | null;
          last_synced_at?: string | null;
          status?: Database["public"]["Enums"]["channel_status"];
          tenant_id: string;
          type: Database["public"]["Enums"]["channel_type"];
          updated_at?: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          display_name?: string;
          external_account_id?: string | null;
          id?: string;
          last_error?: string | null;
          last_synced_at?: string | null;
          status?: Database["public"]["Enums"]["channel_status"];
          tenant_id?: string;
          type?: Database["public"]["Enums"]["channel_type"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channels_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      duplicate_links: {
        Row: {
          created_at: string;
          detected_by: string | null;
          duplicate_ticket_id: string;
          id: string;
          match_reason: string | null;
          primary_ticket_id: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          score: number | null;
          status: Database["public"]["Enums"]["duplicate_link_status"];
          tenant_id: string;
        };
        Insert: {
          created_at?: string;
          detected_by?: string | null;
          duplicate_ticket_id: string;
          id?: string;
          match_reason?: string | null;
          primary_ticket_id: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          score?: number | null;
          status?: Database["public"]["Enums"]["duplicate_link_status"];
          tenant_id: string;
        };
        Update: {
          created_at?: string;
          detected_by?: string | null;
          duplicate_ticket_id?: string;
          id?: string;
          match_reason?: string | null;
          primary_ticket_id?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          score?: number | null;
          status?: Database["public"]["Enums"]["duplicate_link_status"];
          tenant_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "duplicate_links_duplicate_ticket_id_fkey";
            columns: ["duplicate_ticket_id"];
            isOneToOne: false;
            referencedRelation: "tickets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "duplicate_links_primary_ticket_id_fkey";
            columns: ["primary_ticket_id"];
            isOneToOne: false;
            referencedRelation: "tickets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "duplicate_links_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      tenant_members: {
        Row: {
          created_at: string;
          role: Database["public"]["Enums"]["tenant_role"];
          tenant_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          role?: Database["public"]["Enums"]["tenant_role"];
          tenant_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          role?: Database["public"]["Enums"]["tenant_role"];
          tenant_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tenant_members_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      tenants: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          slug: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          slug: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          slug?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ticket_classifications: {
        Row: {
          category: Database["public"]["Enums"]["ticket_category"];
          confidence: number | null;
          contact_number: string | null;
          created_at: string;
          customer_name: string | null;
          id: string;
          item_needing_attention: string | null;
          model: string | null;
          order_number: string | null;
          ordered_items: Json;
          prompt_version: string | null;
          raw_response: Json | null;
          summary: string | null;
          superseded_at: string | null;
          tenant_id: string;
          ticket_id: string;
        };
        Insert: {
          category: Database["public"]["Enums"]["ticket_category"];
          confidence?: number | null;
          contact_number?: string | null;
          created_at?: string;
          customer_name?: string | null;
          id?: string;
          item_needing_attention?: string | null;
          model?: string | null;
          order_number?: string | null;
          ordered_items?: Json;
          prompt_version?: string | null;
          raw_response?: Json | null;
          summary?: string | null;
          superseded_at?: string | null;
          tenant_id: string;
          ticket_id: string;
        };
        Update: {
          category?: Database["public"]["Enums"]["ticket_category"];
          confidence?: number | null;
          contact_number?: string | null;
          created_at?: string;
          customer_name?: string | null;
          id?: string;
          item_needing_attention?: string | null;
          model?: string | null;
          order_number?: string | null;
          ordered_items?: Json;
          prompt_version?: string | null;
          raw_response?: Json | null;
          summary?: string | null;
          superseded_at?: string | null;
          tenant_id?: string;
          ticket_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ticket_classifications_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ticket_classifications_ticket_id_fkey";
            columns: ["ticket_id"];
            isOneToOne: false;
            referencedRelation: "tickets";
            referencedColumns: ["id"];
          },
        ];
      };
      tickets: {
        Row: {
          assigned_to: string | null;
          body: string | null;
          channel_id: string | null;
          closed_at: string | null;
          created_at: string;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          external_id: string | null;
          external_thread_id: string | null;
          id: string;
          last_message_at: string | null;
          merged_into_ticket_id: string | null;
          order_number: string | null;
          raw: Json;
          received_at: string;
          status: Database["public"]["Enums"]["ticket_status"];
          subject: string | null;
          tenant_id: string;
          updated_at: string;
        };
        Insert: {
          assigned_to?: string | null;
          body?: string | null;
          channel_id?: string | null;
          closed_at?: string | null;
          created_at?: string;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          external_id?: string | null;
          external_thread_id?: string | null;
          id?: string;
          last_message_at?: string | null;
          merged_into_ticket_id?: string | null;
          order_number?: string | null;
          raw?: Json;
          received_at?: string;
          status?: Database["public"]["Enums"]["ticket_status"];
          subject?: string | null;
          tenant_id: string;
          updated_at?: string;
        };
        Update: {
          assigned_to?: string | null;
          body?: string | null;
          channel_id?: string | null;
          closed_at?: string | null;
          created_at?: string;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          external_id?: string | null;
          external_thread_id?: string | null;
          id?: string;
          last_message_at?: string | null;
          merged_into_ticket_id?: string | null;
          order_number?: string | null;
          raw?: Json;
          received_at?: string;
          status?: Database["public"]["Enums"]["ticket_status"];
          subject?: string | null;
          tenant_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tickets_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tickets_merged_into_ticket_id_fkey";
            columns: ["merged_into_ticket_id"];
            isOneToOne: false;
            referencedRelation: "tickets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tickets_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      claim_initial_tenant: { Args: { tenant_name: string }; Returns: string };
    };
    Enums: {
      channel_status: "pending" | "connected" | "error" | "disabled";
      channel_type: "shopify" | "outlook" | "whatsapp";
      duplicate_link_status: "suggested" | "confirmed" | "rejected";
      tenant_role: "owner" | "admin" | "agent";
      ticket_category: "enquiry" | "return" | "exchange" | "general_complaint";
      ticket_status: "unopened" | "pending" | "closed";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DefaultSchema = Database["public"];

export type Tables<Name extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][Name]["Row"];

export type TablesInsert<Name extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][Name]["Insert"];

export type TablesUpdate<Name extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][Name]["Update"];

export type Enums<Name extends keyof DefaultSchema["Enums"]> =
  DefaultSchema["Enums"][Name];

export const TICKET_STATUSES = ["unopened", "pending", "closed"] as const;

export const TICKET_CATEGORIES = [
  "enquiry",
  "return",
  "exchange",
  "general_complaint",
] as const;

export const CHANNEL_TYPES = ["shopify", "outlook", "whatsapp"] as const;
