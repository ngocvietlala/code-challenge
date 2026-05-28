import { PostStatus } from "../enums/postStatus";

export interface PostDTO {
    id: number;
    title: string;
    content: string;
    status: PostStatus;
    created_at: Date;
    updated_at: Date;
}

export interface CreatePostInput {
    title: string;
    content: string;
    status?: PostStatus;
}

export type UpdatePostInput = Partial<CreatePostInput>;

export interface ListFilters {
    status?: PostStatus;
    title?: string;
    limit: number;
    offset: number;
}

export interface ListResult {
    data: PostDTO[];
    total: number;
}

export interface PostRepository {
    create(input: CreatePostInput): Promise<PostDTO>;
    list(filters: ListFilters): Promise<ListResult>;
    findById(id: number): Promise<PostDTO | null>;
    update(id: number, input: UpdatePostInput): Promise<PostDTO | null>;
    destroy(id: number): Promise<boolean>;
}
