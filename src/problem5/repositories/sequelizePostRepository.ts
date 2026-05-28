import { Op, WhereOptions } from "sequelize";
import { Post, PostAttributes } from "../models/post";
import {
    CreatePostInput,
    ListFilters,
    ListResult,
    PostDTO,
    PostRepository,
    UpdatePostInput,
} from "./postTypes";

function toDTO(post: Post): PostDTO {
    return post.get({ plain: true }) as PostDTO;
}

export class SequelizePostRepository implements PostRepository {
    async create(input: CreatePostInput): Promise<PostDTO> {
        const created = await Post.create({
            title: input.title,
            content: input.content,
            status: input.status ?? 0,
        });
        return toDTO(created);
    }

    async list(filters: ListFilters): Promise<ListResult> {
        const where: WhereOptions<PostAttributes> = {};
        if (filters.status !== undefined) where.status = filters.status;
        if (filters.title !== undefined && filters.title !== "") {
            where.title = { [Op.like]: `%${filters.title}%` };
        }

        const { rows, count } = await Post.findAndCountAll({
            where,
            limit: filters.limit,
            offset: filters.offset,
            order: [["id", "DESC"]],
        });

        return { data: rows.map(toDTO), total: count };
    }

    async findById(id: number): Promise<PostDTO | null> {
        const found = await Post.findByPk(id);
        return found ? toDTO(found) : null;
    }

    async update(id: number, input: UpdatePostInput): Promise<PostDTO | null> {
        const found = await Post.findByPk(id);
        if (!found) return null;

        if (input.title !== undefined) found.title = input.title;
        if (input.content !== undefined) found.content = input.content;
        if (input.status !== undefined) found.status = input.status;

        await found.save();
        return toDTO(found);
    }

    async destroy(id: number): Promise<boolean> {
        const removed = await Post.destroy({ where: { id } });
        return removed > 0;
    }
}
