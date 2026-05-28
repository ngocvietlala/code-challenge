import { Response } from "express";
import { StatusCodes } from "http-status-codes";

export interface PaginationMeta {
    total: number;
    limit: number;
    offset: number;
}

export function responseSuccess<T>(res: Response, data: T, message?: string): void {
    res.status(StatusCodes.OK).json({ success: true, message, data });
}

export function responseCreated<T>(res: Response, data: T, message?: string): void {
    res.status(StatusCodes.CREATED).json({ success: true, message, data });
}

export function responsePaginated<T>(
    res: Response,
    items: T[],
    meta: PaginationMeta,
    message?: string,
): void {
    res.status(StatusCodes.OK).json({ success: true, message, items, meta });
}

export function responseNoContent(res: Response): void {
    res.status(StatusCodes.NO_CONTENT).send();
}
