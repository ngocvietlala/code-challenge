import Joi from "joi";
import { PostStatus } from "../enums/postStatus";

const status = Joi.number()
    .integer()
    .valid(...Object.values(PostStatus));

export const createPostBody = Joi.object({
    title: Joi.string().trim().min(1).max(255).required(),
    content: Joi.string().trim().min(1).required(),
    status: status.default(PostStatus.Draft),
});

export const updatePostBody = Joi.object({
    title: Joi.string().trim().min(1).max(255),
    content: Joi.string().trim().min(1),
    status,
})
    .min(1)
    .messages({
        "object.min": "request body must include at least one of: title, content, status",
    });

export const listPostsQuery = Joi.object({
    status,
    title: Joi.string().trim().min(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    offset: Joi.number().integer().min(0).default(0),
});

export const postIdParam = Joi.object({
    id: Joi.number().integer().positive().required(),
});
