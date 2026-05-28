import { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import Joi from "joi";
import { HttpError } from "../exceptions/httpError";

type Source = "body" | "query" | "params";

export function validate(source: Source, schema: Joi.Schema): RequestHandler {
    return (req, _res, next) => {
        const { error, value } = schema.validate(req[source], {
            abortEarly: false,
            stripUnknown: true,
            convert: true,
        });

        if (error) {
            const message = error.details.map((d) => d.message).join("; ");
            return next(new HttpError(StatusCodes.BAD_REQUEST, message));
        }

        // Replace the request slot with the coerced/defaulted value so
        // handlers always see the validated shape.
        Object.defineProperty(req, source, { value, writable: true, configurable: true });
        next();
    };
}
