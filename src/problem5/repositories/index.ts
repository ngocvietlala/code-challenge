import { PostRepository } from "./postTypes";
import { SequelizePostRepository } from "./sequelizePostRepository";

export const postRepository: PostRepository = new SequelizePostRepository();

export * from "./postTypes";
