import { Request, RequestHandler, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { HttpError } from "../exceptions/httpError";
import {
    responseCreated,
    responseNoContent,
    responsePaginated,
    responseSuccess,
} from "../helpers/response";
import { validate } from "../middleware/validate";
import {
    CreatePostInput,
    ListFilters,
    UpdatePostInput,
    postRepository,
} from "../repositories";
import {
    createPostBody,
    listPostsQuery,
    postIdParam,
    updatePostBody,
} from "../validators/postValidator";

// Each action is exported as an Express middleware chain — validation
// runs first, then the handler. Routes just point a URL at one of these
// chains, mirroring Laravel's FormRequest-on-action pattern.

async function create(req: Request, res: Response): Promise<void> {
    const post = await postRepository.create(req.body as CreatePostInput);
    responseCreated(res, post);
}

async function list(req: Request, res: Response): Promise<void> {
    const filters = req.query as unknown as ListFilters;
    const { data, total } = await postRepository.list(filters);
    responsePaginated(res, data, { total, limit: filters.limit, offset: filters.offset });
}

async function show(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const found = await postRepository.findById(id);
    if (!found) throw new HttpError(StatusCodes.NOT_FOUND, `post ${id} not found`);
    responseSuccess(res, found);
}

async function update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const updated = await postRepository.update(id, req.body as UpdatePostInput);
    if (!updated) throw new HttpError(StatusCodes.NOT_FOUND, `post ${id} not found`);
    responseSuccess(res, updated);
}

async function destroy(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const removed = await postRepository.destroy(id);
    if (!removed) throw new HttpError(StatusCodes.NOT_FOUND, `post ${id} not found`);
    responseNoContent(res);
}

export const postController: Record<string, RequestHandler[]> = {
    create: [validate("body", createPostBody), create],
    list: [validate("query", listPostsQuery), list],
    show: [validate("params", postIdParam), show],
    update: [
        validate("params", postIdParam),
        validate("body", updatePostBody),
        update,
    ],
    destroy: [validate("params", postIdParam), destroy],
};
