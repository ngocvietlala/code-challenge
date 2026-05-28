export const PostStatus = {
    Draft: 0,
    Published: 1,
    Archived: 2,
} as const;
export type PostStatus = (typeof PostStatus)[keyof typeof PostStatus];
