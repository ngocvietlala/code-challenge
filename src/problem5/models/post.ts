import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from "sequelize";
import { sequelize } from "../config/database";
import { PostStatus } from "../enums/postStatus";

export class Post extends Model<InferAttributes<Post>, InferCreationAttributes<Post>> {
    declare id: CreationOptional<number>;
    declare title: string;
    declare content: string;
    declare status: CreationOptional<number>;
    declare readonly created_at: CreationOptional<Date>;
    declare readonly updated_at: CreationOptional<Date>;
}

export type PostAttributes = InferAttributes<Post>;

Post.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false,
            validate: { notEmpty: true, len: [1, 255] },
        },
        content: {
            type: DataTypes.TEXT,
            allowNull: false,
            validate: { notEmpty: true },
        },
        status: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: PostStatus.Draft,
            validate: {
                isKnownStatus(value: unknown) {
                    if (!Object.values(PostStatus).includes(value as PostStatus)) {
                        throw new Error(
                            `status must be one of: ${Object.values(PostStatus).join(", ")}`,
                        );
                    }
                },
            },
        },
        created_at: DataTypes.DATE,
        updated_at: DataTypes.DATE,
    },
    {
        sequelize,
        modelName: "Post",
        tableName: "posts",
        timestamps: true,
        underscored: true,
        createdAt: "created_at",
        updatedAt: "updated_at",
    },
);
